use arc_agent::config::{AuthConfig, Config, SourceConfig};

#[test]
fn parses_minimal_kv_config() {
    let yaml = r#"
arc:
  server: http://arc:3001
  auth:
    type: kubernetes
    role: web

sinks:
  - id: db
    template_file: ./db.tmpl
    output_path: /tmp/db.conf
    source:
      type: kv_get
      path: app/prod/db
"#;
    let cfg = Config::parse(yaml).expect("parse");
    cfg.validate().expect("validate");
    assert_eq!(cfg.sinks.len(), 1);
    let s = &cfg.sinks[0];
    assert_eq!(s.id, "db");
    assert_eq!(s.refresh_interval_seconds, 300);
    assert_eq!(s.mode, "0600");
    match &s.source {
        SourceConfig::KvGet { mount, path, .. } => {
            assert_eq!(mount, "secret"); // default
            assert_eq!(path, "app/prod/db");
        }
        _ => panic!("expected kv_get"),
    }
    match &cfg.arc.auth {
        AuthConfig::Kubernetes { mount, role, .. } => {
            assert_eq!(mount, "kubernetes");
            assert_eq!(role, "web");
        }
    }
}

#[test]
fn parses_dynamic_config_with_on_change_command() {
    let yaml = r#"
arc:
  server: http://arc:3001
  auth:
    type: kubernetes
    mount: kubernetes
    role: deployer
    token_file: /var/run/x

sinks:
  - id: aws
    template_file: ./aws.tmpl
    output_path: /etc/app/aws.env
    mode: "0640"
    source:
      type: dynamic_creds
      mount: aws
      role: deployer
      ttl_seconds: 900
    refresh_lead_seconds: 90
    on_change:
      command: ["/usr/local/bin/reload"]
"#;
    let cfg = Config::parse(yaml).expect("parse");
    cfg.validate().expect("validate");
    let s = &cfg.sinks[0];
    assert_eq!(s.refresh_lead_seconds, 90);
    assert_eq!(s.mode, "0640");
    match &s.source {
        SourceConfig::DynamicCreds { mount, role, ttl_seconds } => {
            assert_eq!(mount, "aws");
            assert_eq!(role, "deployer");
            assert_eq!(*ttl_seconds, Some(900));
        }
        _ => panic!(),
    }
}

#[test]
fn rejects_duplicate_sink_ids() {
    let yaml = r#"
arc:
  server: http://arc
  auth: { type: kubernetes, role: x }

sinks:
  - id: a
    template_file: ./a
    output_path: /tmp/a
    source: { type: kv_get, path: x }
  - id: a
    template_file: ./b
    output_path: /tmp/b
    source: { type: kv_get, path: y }
"#;
    let cfg = Config::parse(yaml).unwrap();
    let err = cfg.validate().unwrap_err();
    assert!(format!("{err}").contains("duplicate"));
}

#[test]
fn rejects_on_change_missing_command_and_signal() {
    let yaml = r#"
arc:
  server: http://arc
  auth: { type: kubernetes, role: x }

sinks:
  - id: a
    template_file: ./a
    output_path: /tmp/a
    source: { type: kv_get, path: x }
    on_change: {}
"#;
    let cfg = Config::parse(yaml).unwrap();
    let err = cfg.validate().unwrap_err();
    assert!(format!("{err}").contains("on_change"));
}
