//! Thin client to arc-server's REST API. Owns the lifecycle of the arc JWT — logs in via
//! the configured auth method on first use and refreshes ahead of expiry.
//!
//! Trust model: this client never decides authorization. arc-server's `JwtAuthGuard` +
//! `CapabilityGuard` (against `@arc/grants`) gate every call; a 403 propagates as an error
//! to the caller without retry. On 401 we drop the cached token and retry once — that
//! covers the case where the token was revoked server-side (policy detach + cache miss).

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;
use zeroize::Zeroize;

use crate::config::AuthConfig;

/// JWT-clearing wrapper so the cached token isn't left lying around in process memory longer
/// than necessary. We don't zeroize on every clone (that'd defeat the purpose); we zeroize
/// when the cache entry is replaced.
struct CachedJwt {
    token: String,
    expires_at: Instant,
}

impl Drop for CachedJwt {
    fn drop(&mut self) {
        self.token.zeroize();
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LoginResponse {
    pub data: LoginData,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LoginData {
    pub token: String,
    #[serde(default)]
    pub identity_id: String,
    #[serde(default)]
    pub policies: Vec<String>,
    pub token_ttl_seconds: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KvResponse {
    pub data: KvBody,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KvBody {
    pub data: serde_json::Value,
    #[serde(default)]
    pub metadata: KvMetadata,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct KvMetadata {
    #[serde(default)]
    pub version: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DynamicCredsResponse {
    pub data: serde_json::Value,
    pub lease_id: String,
    pub lease_duration: u64,
    #[serde(default)]
    pub renewable: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum ArcError {
    #[error("arc-server HTTP error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("arc-server returned {status}: {body}")]
    Server { status: u16, body: String },
    #[error("auth: failed to read token file: {0}")]
    TokenIo(#[from] std::io::Error),
    #[error("auth: not yet configured (call login() first)")]
    NotAuthenticated,
}

/// Hook used by tests to swap out the source of the SA token (or the OIDC ID token, when we
/// grow that auth type).
#[async_trait::async_trait]
pub trait TokenSource: Send + Sync {
    async fn read_token(&self) -> Result<String, ArcError>;
}

pub struct FileTokenSource {
    pub path: std::path::PathBuf,
}

#[async_trait::async_trait]
impl TokenSource for FileTokenSource {
    async fn read_token(&self) -> Result<String, ArcError> {
        let raw = tokio::fs::read_to_string(&self.path).await?;
        Ok(raw.trim().to_string())
    }
}

#[derive(Clone)]
pub struct ArcClient {
    base_url: String,
    auth: AuthConfig,
    http: reqwest::Client,
    token_source: Arc<dyn TokenSource>,
    cache: Arc<Mutex<Option<CachedJwt>>>,
    refresh_lead: Duration,
}

impl ArcClient {
    pub fn new(
        base_url: impl Into<String>,
        auth: AuthConfig,
        token_source: Arc<dyn TokenSource>,
    ) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .expect("reqwest client");
        Self {
            base_url: base_url.into(),
            auth,
            http,
            token_source,
            cache: Arc::new(Mutex::new(None)),
            refresh_lead: Duration::from_secs(60),
        }
    }

    /// Lets tests construct the client with an injectable HTTP client + clock.
    pub fn new_with_http(
        base_url: impl Into<String>,
        auth: AuthConfig,
        token_source: Arc<dyn TokenSource>,
        http: reqwest::Client,
    ) -> Self {
        Self {
            base_url: base_url.into(),
            auth,
            http,
            token_source,
            cache: Arc::new(Mutex::new(None)),
            refresh_lead: Duration::from_secs(60),
        }
    }

    /// Force a login. Returns the new arc JWT.
    pub async fn login(&self) -> Result<String, ArcError> {
        let token = match &self.auth {
            AuthConfig::Kubernetes { mount, role, .. } => {
                self.login_kubernetes(mount, role).await?
            }
        };
        Ok(token)
    }

    async fn login_kubernetes(&self, mount: &str, role: &str) -> Result<String, ArcError> {
        let sa_token = self.token_source.read_token().await?;
        let url = format!("{}/v1/auth/{}/login", self.base_url.trim_end_matches('/'), mount);
        let body = serde_json::json!({ "role": role, "jwt": sa_token });
        let res = self
            .http
            .post(&url)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .json(&body)
            .send()
            .await?;
        let status = res.status();
        if !status.is_success() {
            let body = res.text().await.unwrap_or_default();
            return Err(ArcError::Server {
                status: status.as_u16(),
                body,
            });
        }
        let parsed: LoginResponse = res.json().await?;
        let ttl = Duration::from_secs(parsed.data.token_ttl_seconds);
        let cached = CachedJwt {
            token: parsed.data.token.clone(),
            expires_at: Instant::now() + ttl,
        };
        let mut guard = self.cache.lock().await;
        *guard = Some(cached);
        Ok(parsed.data.token)
    }

    /// Return a non-expired arc JWT, logging in if necessary.
    async fn jwt(&self) -> Result<String, ArcError> {
        let now = Instant::now();
        {
            let guard = self.cache.lock().await;
            if let Some(entry) = guard.as_ref() {
                if entry.expires_at.saturating_duration_since(now) > self.refresh_lead {
                    return Ok(entry.token.clone());
                }
            }
        }
        self.login().await
    }

    pub async fn forget_token(&self) {
        let mut guard = self.cache.lock().await;
        *guard = None;
    }

    /// `GET /v1/<mount>/data/<path>` — KV v2 read.
    pub async fn kv_get(
        &self,
        mount: &str,
        path: &str,
        version: Option<u64>,
    ) -> Result<KvResponse, ArcError> {
        let mut url = format!(
            "{}/v1/{}/data/{}",
            self.base_url.trim_end_matches('/'),
            mount.trim_matches('/'),
            path.trim_start_matches('/')
        );
        if let Some(v) = version {
            url.push_str(&format!("?version={}", v));
        }
        self.authed_json("GET", &url, None).await
    }

    /// `GET /v1/<mount>/creds/<role>` — issue dynamic credentials.
    pub async fn issue_dynamic(
        &self,
        mount: &str,
        role: &str,
        ttl_seconds: Option<u64>,
    ) -> Result<DynamicCredsResponse, ArcError> {
        let mut url = format!(
            "{}/v1/{}/creds/{}",
            self.base_url.trim_end_matches('/'),
            mount.trim_matches('/'),
            role.trim_start_matches('/')
        );
        if let Some(t) = ttl_seconds {
            url.push_str(&format!("?ttl={}", t));
        }
        self.authed_json("GET", &url, None).await
    }

    /// `POST /v1/sys/leases/revoke` — best-effort revoke.
    pub async fn revoke_lease(&self, lease_id: &str) -> Result<(), ArcError> {
        let url = format!("{}/v1/sys/leases/revoke", self.base_url.trim_end_matches('/'));
        let body = serde_json::json!({ "lease_id": lease_id });
        let _: serde_json::Value = self.authed_json("POST", &url, Some(body)).await?;
        Ok(())
    }

    async fn authed_json<T: for<'de> Deserialize<'de>>(
        &self,
        method: &str,
        url: &str,
        body: Option<serde_json::Value>,
    ) -> Result<T, ArcError> {
        let res = self.do_authed_request(method, url, body.clone()).await?;
        let status = res.status();
        // One retry on 401: cached token may have been revoked.
        if status == reqwest::StatusCode::UNAUTHORIZED {
            self.forget_token().await;
            let retry = self.do_authed_request(method, url, body).await?;
            return parse_or_err(retry).await;
        }
        parse_or_err(res).await
    }

    async fn do_authed_request(
        &self,
        method: &str,
        url: &str,
        body: Option<serde_json::Value>,
    ) -> Result<reqwest::Response, ArcError> {
        let jwt = self.jwt().await?;
        let mut req = self
            .http
            .request(reqwest::Method::from_bytes(method.as_bytes()).unwrap(), url)
            .bearer_auth(&jwt)
            .header(reqwest::header::ACCEPT, "application/json");
        if let Some(b) = body {
            req = req.json(&b);
        }
        Ok(req.send().await?)
    }
}

async fn parse_or_err<T: for<'de> Deserialize<'de>>(
    res: reqwest::Response,
) -> Result<T, ArcError> {
    let status = res.status();
    let body = res.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(ArcError::Server {
            status: status.as_u16(),
            body,
        });
    }
    if body.is_empty() {
        // Coerce empty body into T = serde_json::Value::Null for the revoke path.
        let null = serde_json::Value::Null;
        return Ok(serde_json::from_value::<T>(null).map_err(|_| ArcError::Server {
            status: 200,
            body: "empty body".into(),
        })?);
    }
    Ok(serde_json::from_str::<T>(&body).map_err(|e| ArcError::Server {
        status: status.as_u16(),
        body: format!("parse error: {} (body: {})", e, body),
    })?)
}
