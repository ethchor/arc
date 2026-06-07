use arc_agent::template::render;
use serde_json::json;

#[test]
fn renders_kv_into_dotenv() {
    let tmpl = "DATABASE_URL=postgres://{{ data.user }}:{{ data.pass }}@{{ data.host }}/{{ data.db }}\n# v={{ meta.version }}\n";
    let data = json!({ "user": "alice", "pass": "s3cr3t", "host": "db.svc", "db": "app" });
    let meta = json!({ "version": 7 });
    let out = render(tmpl, &data, &meta).unwrap();
    assert_eq!(out, "DATABASE_URL=postgres://alice:s3cr3t@db.svc/app\n# v=7\n");
}

#[test]
fn renders_dynamic_creds_with_lease_metadata() {
    let tmpl = "[default]\naws_access_key_id={{ data.access_key }}\naws_secret_access_key={{ data.secret_key }}\naws_session_token={{ data.session_token }}\n# lease={{ meta.lease_id }} ttl={{ meta.lease_duration }}\n";
    let data = json!({ "access_key": "AKIA...", "secret_key": "secret", "session_token": "tok" });
    let meta = json!({ "lease_id": "aws/.../1", "lease_duration": 900 });
    let out = render(tmpl, &data, &meta).unwrap();
    assert!(out.contains("aws_access_key_id=AKIA..."));
    assert!(out.contains("# lease=aws/.../1 ttl=900"));
}

#[test]
fn missing_dotted_field_errors_rather_than_rendering_empty() {
    // Tera's one_off errors on a missing dotted variable — so a typo'd `{{ data.passw0rd }}`
    // surfaces as a sink-tick failure (logged + recorded) instead of silently producing a
    // config file with a blank password. Catches operator template typos in the loud way.
    let tmpl = "{{ data.password }}";
    let data = json!({ "username": "u" });
    let err = render(tmpl, &data, &json!({})).err().expect("should error");
    // The interesting text is on the Tera source chain, not the outer wrapper — use Debug.
    let dbg = format!("{err:?}");
    assert!(dbg.contains("data.password"), "expected `data.password` in {dbg}");
    assert!(dbg.to_lowercase().contains("not found"), "expected `not found` in {dbg}");
}
