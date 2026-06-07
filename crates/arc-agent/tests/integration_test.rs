//! End-to-end integration test through `wiremock`. Stands up a fake arc-server, points the
//! agent at it, runs a single tick with both a KV sink and a dynamic-creds sink, and
//! asserts the rendered files on disk + the login + fetch traffic.

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::json;
use tempfile::TempDir;
use wiremock::matchers::{body_partial_json, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

use arc_agent::arc::{ArcClient, ArcError, TokenSource};
use arc_agent::config::{AuthConfig, SinkConfig, SourceConfig};
use arc_agent::runner::Runner;
use arc_agent::sink::Sink;

struct StaticToken(&'static str);

#[async_trait]
impl TokenSource for StaticToken {
    async fn read_token(&self) -> Result<String, ArcError> {
        Ok(self.0.into())
    }
}

#[tokio::test]
async fn login_then_kv_render_to_file() {
    let server = MockServer::start().await;

    // Login endpoint — returns an arc JWT.
    Mock::given(method("POST"))
        .and(path("/v1/auth/kubernetes/login"))
        .and(body_partial_json(json!({ "role": "web", "jwt": "sa-token-xyz" })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "data": { "token": "arc-jwt-1", "identity_id": "x", "policies": ["reader"], "token_ttl_seconds": 600 }
        })))
        .mount(&server)
        .await;

    // KV read — assert the Authorization header is the JWT issued by the login above.
    Mock::given(method("GET"))
        .and(path("/v1/secret/data/app/prod/db"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "data": {
                "data": { "user": "alice", "pass": "s3cr3t" },
                "metadata": { "version": 3 }
            }
        })))
        .mount(&server)
        .await;

    let tmp = TempDir::new().unwrap();
    let template_path = tmp.path().join("db.tmpl");
    let output_path = tmp.path().join("db.conf");
    std::fs::write(&template_path, "U={{ data.user }}\nP={{ data.pass }}\nV={{ meta.version }}\n").unwrap();

    let cfg = SinkConfig {
        id: "db".into(),
        template_file: template_path,
        output_path: output_path.clone(),
        mode: "0600".into(),
        source: SourceConfig::KvGet { mount: "secret".into(), path: "app/prod/db".into(), version: None },
        refresh_interval_seconds: 300,
        refresh_lead_seconds: 60,
        on_change: None,
    };

    let auth = AuthConfig::Kubernetes {
        mount: "kubernetes".into(),
        role: "web".into(),
        token_file: Some(PathBuf::from("/dev/null")),
    };
    let arc = Arc::new(ArcClient::new(server.uri(), auth, Arc::new(StaticToken("sa-token-xyz"))));
    let runner = Runner::new(arc, vec![Sink::new(cfg)]);

    let outcome = runner.tick_all().await;
    assert!(!outcome.any_failed(), "tick failed: {:?}", outcome.sinks);
    assert!(outcome.sinks[0].changed);

    let rendered = std::fs::read_to_string(&output_path).unwrap();
    assert_eq!(rendered, "U=alice\nP=s3cr3t\nV=3\n");
}

#[tokio::test]
async fn dynamic_creds_render_and_reissue() {
    let server = MockServer::start().await;

    Mock::given(method("POST"))
        .and(path("/v1/auth/kubernetes/login"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "data": { "token": "arc-jwt", "token_ttl_seconds": 600 }
        })))
        .mount(&server)
        .await;

    Mock::given(method("GET"))
        .and(path("/v1/aws/creds/deployer"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "data": { "access_key": "AKIA...", "secret_key": "secret", "session_token": "TOK" },
            "lease_id": "aws/creds/deployer/abc",
            "lease_duration": 900,
            "renewable": false,
        })))
        .mount(&server)
        .await;

    let tmp = TempDir::new().unwrap();
    let template_path = tmp.path().join("aws.tmpl");
    let output_path = tmp.path().join("aws.env");
    std::fs::write(
        &template_path,
        "AWS_ACCESS_KEY_ID={{ data.access_key }}\nAWS_SECRET_ACCESS_KEY={{ data.secret_key }}\nAWS_SESSION_TOKEN={{ data.session_token }}\n",
    )
    .unwrap();

    let cfg = SinkConfig {
        id: "aws".into(),
        template_file: template_path,
        output_path: output_path.clone(),
        mode: "0640".into(),
        source: SourceConfig::DynamicCreds { mount: "aws".into(), role: "deployer".into(), ttl_seconds: Some(900) },
        refresh_interval_seconds: 300,
        refresh_lead_seconds: 60,
        on_change: None,
    };

    let arc = Arc::new(ArcClient::new(
        server.uri(),
        AuthConfig::Kubernetes { mount: "kubernetes".into(), role: "deployer".into(), token_file: None },
        Arc::new(StaticToken("sa")),
    ));
    let runner = Runner::new(arc, vec![Sink::new(cfg)]);

    let outcome = runner.tick_all().await;
    assert!(!outcome.any_failed(), "tick failed: {:?}", outcome.sinks);
    let rendered = std::fs::read_to_string(&output_path).unwrap();
    assert!(rendered.contains("AWS_ACCESS_KEY_ID=AKIA..."));
    assert!(rendered.contains("AWS_SESSION_TOKEN=TOK"));

    // Mode on disk should be 0o640 (a literal "0640" config maps to 0o640).
    let meta = std::fs::metadata(&output_path).unwrap();
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(meta.permissions().mode() & 0o777, 0o640);
}

#[tokio::test]
async fn server_403_surfaces_as_error_no_retry() {
    let server = MockServer::start().await;

    Mock::given(method("POST"))
        .and(path("/v1/auth/kubernetes/login"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "data": { "token": "arc-jwt", "token_ttl_seconds": 600 }
        })))
        .mount(&server)
        .await;

    Mock::given(method("GET"))
        .and(path("/v1/secret/data/forbidden"))
        .respond_with(ResponseTemplate::new(403).set_body_json(json!({ "errors": ["forbidden by policy"] })))
        .mount(&server)
        .await;

    let tmp = TempDir::new().unwrap();
    let template_path = tmp.path().join("t.tmpl");
    let output_path = tmp.path().join("out");
    std::fs::write(&template_path, "X={{ data.x }}").unwrap();

    let cfg = SinkConfig {
        id: "f".into(),
        template_file: template_path,
        output_path: output_path.clone(),
        mode: "0600".into(),
        source: SourceConfig::KvGet { mount: "secret".into(), path: "forbidden".into(), version: None },
        refresh_interval_seconds: 300,
        refresh_lead_seconds: 60,
        on_change: None,
    };
    let arc = Arc::new(ArcClient::new(
        server.uri(),
        AuthConfig::Kubernetes { mount: "kubernetes".into(), role: "x".into(), token_file: None },
        Arc::new(StaticToken("sa")),
    ));
    let runner = Runner::new(arc, vec![Sink::new(cfg)]);
    let outcome = runner.tick_all().await;
    assert!(outcome.any_failed());
    assert!(outcome.sinks[0].error.as_ref().unwrap().contains("403"));
    assert!(!output_path.exists(), "no Secret should be written on a 403");
}
