use std::{
    env,
    time::{Duration, Instant},
};

use anyhow::{anyhow, Context, Result};
use clap::Parser;
use futures_util::StreamExt;
use reqwest::Client;
use serde::Serialize;
use serde_json::{json, Value};
use tokio::time;
use tokio_tungstenite::connect_async;

#[derive(Debug, Parser)]
#[command(about = "Verify deployed rover bots are running the Rust robot-harness")]
struct Opts {
    /// Bot URL in name=http://host:8000 form. Repeat for guard/courier.
    #[arg(long = "bot")]
    bots: Vec<String>,

    /// Sidecar URL printed in reset remediation commands.
    #[arg(long, env = "SIDECAR_URL", default_value = "http://192.168.0.100:4021")]
    sidecar_url: String,

    /// Jetson repo path printed in reset remediation commands.
    #[arg(long, default_value = "~/onchain-rover")]
    jetson_repo_dir: String,

    /// SSH user printed in reset remediation commands.
    #[arg(long, default_value = "jetson")]
    ssh_user: String,

    /// Request timeout in milliseconds.
    #[arg(long, default_value_t = 2500)]
    timeout_ms: u64,

    /// Do not require /capabilities and /sensors Rust endpoints.
    #[arg(long)]
    allow_legacy: bool,

    /// Skip /stream header probe.
    #[arg(long)]
    skip_stream: bool,

    /// Skip final stop calls.
    #[arg(long)]
    no_stop: bool,

    /// Emit machine-readable JSON.
    #[arg(long)]
    json: bool,
}

#[derive(Debug, Clone)]
struct Bot {
    name: String,
    url: String,
}

#[derive(Debug, Serialize)]
struct Report {
    ok: bool,
    generated_at_ms: u128,
    bots: Vec<BotReport>,
}

#[derive(Debug, Serialize)]
struct BotReport {
    name: String,
    url: String,
    ok: bool,
    checks: Vec<Check>,
    reset_command: String,
}

#[derive(Debug, Serialize)]
struct Check {
    name: &'static str,
    status: CheckStatus,
    detail: String,
    latency_ms: u128,
}

#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum CheckStatus {
    Pass,
    Warn,
    Fail,
}

#[tokio::main]
async fn main() -> Result<()> {
    let opts = Opts::parse();
    let bots = parse_bots(&opts)?;
    let client = Client::builder()
        .connect_timeout(Duration::from_millis(opts.timeout_ms))
        .build()
        .context("build HTTP client")?;

    let mut reports = Vec::new();
    for bot in bots {
        reports.push(check_bot(&opts, &client, bot).await);
    }

    let report = Report {
        ok: reports.iter().all(|bot| bot.ok),
        generated_at_ms: now_ms(),
        bots: reports,
    };

    if opts.json {
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else {
        print_human(&report);
    }

    if report.ok {
        Ok(())
    } else {
        Err(anyhow!("one or more bots failed deploy checks"))
    }
}

fn parse_bots(opts: &Opts) -> Result<Vec<Bot>> {
    let mut bots = Vec::new();
    for value in &opts.bots {
        let (name, url) = value
            .split_once('=')
            .ok_or_else(|| anyhow!("--bot must be name=http://host:port, got {value}"))?;
        bots.push(Bot {
            name: name.to_string(),
            url: normalize_http_url(url),
        });
    }

    if bots.is_empty() {
        if let Ok(url) = env::var("GUARD_URL") {
            bots.push(Bot {
                name: "guard".to_string(),
                url: normalize_http_url(&url),
            });
        }
        if let Ok(url) = env::var("COURIER_URL") {
            bots.push(Bot {
                name: "courier".to_string(),
                url: normalize_http_url(&url),
            });
        }
    }

    if bots.is_empty() {
        return Err(anyhow!(
            "provide at least one --bot guard=http://host:8000 or set GUARD_URL/COURIER_URL"
        ));
    }
    Ok(bots)
}

async fn check_bot(opts: &Opts, client: &Client, bot: Bot) -> BotReport {
    let mut checks = Vec::new();

    let health = get_json(client, &bot.url, "/health", opts.timeout_ms).await;
    checks.push(http_json_check("health", &health, |value| {
        value.get("ok").and_then(Value::as_bool) != Some(false)
    }));

    let capabilities = get_json(client, &bot.url, "/capabilities", opts.timeout_ms).await;
    checks.push(
        http_json_check("rust capabilities", &capabilities, |value| {
            value.get("ok").and_then(Value::as_bool) == Some(true)
                && value
                    .get("endpoints")
                    .and_then(Value::as_array)
                    .is_some_and(|endpoints| {
                        endpoints
                            .iter()
                            .any(|item| item.as_str() == Some("WS /ws/telemetry"))
                    })
        })
        .with_required(!opts.allow_legacy),
    );

    let sensors = get_json(client, &bot.url, "/sensors", opts.timeout_ms).await;
    checks.push(
        http_json_check("sensors", &sensors, |value| {
            value.get("ok").and_then(Value::as_bool) == Some(true) && value.get("sensors").is_some()
        })
        .with_required(!opts.allow_legacy),
    );

    let camera = get_json(client, &bot.url, "/camera/status", opts.timeout_ms).await;
    checks.push(camera_check(&camera));

    if !opts.skip_stream {
        checks.push(stream_check(client, &bot.url, opts.timeout_ms).await);
    }

    checks.push(telemetry_ws_check(&bot.url, opts.timeout_ms).await);

    if !opts.no_stop {
        checks.push(stop_check(client, &bot.url, opts.timeout_ms).await);
    }

    let ok = checks.iter().all(|check| check.status != CheckStatus::Fail);
    BotReport {
        reset_command: reset_command(opts, &bot),
        name: bot.name,
        url: bot.url,
        ok,
        checks,
    }
}

#[derive(Debug)]
struct Probe {
    ok: bool,
    status: Option<u16>,
    latency_ms: u128,
    body: Option<Value>,
    error: Option<String>,
}

async fn get_json(client: &Client, base: &str, path: &str, timeout_ms: u64) -> Probe {
    let started = Instant::now();
    let result = time::timeout(
        Duration::from_millis(timeout_ms),
        client.get(format!("{base}{path}")).send(),
    )
    .await;
    match result {
        Ok(Ok(response)) => {
            let status = response.status().as_u16();
            let ok = response.status().is_success();
            let text = response.text().await.unwrap_or_default();
            let body = serde_json::from_str(&text).ok();
            Probe {
                ok,
                status: Some(status),
                latency_ms: started.elapsed().as_millis(),
                body,
                error: if ok {
                    None
                } else {
                    Some(text.trim().to_string())
                },
            }
        }
        Ok(Err(err)) => Probe {
            ok: false,
            status: None,
            latency_ms: started.elapsed().as_millis(),
            body: None,
            error: Some(err.to_string()),
        },
        Err(_) => Probe {
            ok: false,
            status: None,
            latency_ms: started.elapsed().as_millis(),
            body: None,
            error: Some("timeout".to_string()),
        },
    }
}

fn http_json_check(
    name: &'static str,
    probe: &Probe,
    validate: impl FnOnce(&Value) -> bool,
) -> Check {
    let valid = probe.body.as_ref().is_some_and(validate);
    let status = if probe.ok && valid {
        CheckStatus::Pass
    } else {
        CheckStatus::Fail
    };
    Check {
        name,
        status,
        detail: probe_detail(probe),
        latency_ms: probe.latency_ms,
    }
}

trait RequiredCheck {
    fn with_required(self, required: bool) -> Self;
}

impl RequiredCheck for Check {
    fn with_required(mut self, required: bool) -> Self {
        if !required && self.status == CheckStatus::Fail {
            self.status = CheckStatus::Warn;
        }
        self
    }
}

fn camera_check(probe: &Probe) -> Check {
    let status_text = probe
        .body
        .as_ref()
        .and_then(|body| body.get("status"))
        .and_then(Value::as_str);
    let health = probe
        .body
        .as_ref()
        .and_then(|body| body.get("health"))
        .and_then(Value::as_str);
    let status = if probe.ok
        && matches!(
            status_text,
            Some("device" | "proxy" | "simulated" | "configured")
        )
        && health != Some("missing")
    {
        CheckStatus::Pass
    } else if probe.ok {
        CheckStatus::Warn
    } else {
        CheckStatus::Fail
    };
    Check {
        name: "camera status",
        status,
        detail: probe_detail(probe),
        latency_ms: probe.latency_ms,
    }
}

async fn stream_check(client: &Client, base: &str, timeout_ms: u64) -> Check {
    let started = Instant::now();
    let result = time::timeout(
        Duration::from_millis(timeout_ms),
        client.get(format!("{base}/stream")).send(),
    )
    .await;
    match result {
        Ok(Ok(response)) => {
            let status = response.status();
            let content_type = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .unwrap_or("")
                .to_string();
            let mut stream = response.bytes_stream();
            let first_chunk = time::timeout(Duration::from_millis(timeout_ms), stream.next()).await;
            let bytes = match first_chunk {
                Ok(Some(Ok(bytes))) => bytes.len(),
                _ => 0,
            };
            let ok = status.is_success()
                && bytes > 0
                && (content_type.contains("multipart")
                    || content_type.contains("image/")
                    || content_type.contains("svg"));
            Check {
                name: "camera stream",
                status: if ok {
                    CheckStatus::Pass
                } else {
                    CheckStatus::Warn
                },
                detail: format!(
                    "HTTP {} {content_type}, first chunk {bytes} bytes",
                    status.as_u16()
                ),
                latency_ms: started.elapsed().as_millis(),
            }
        }
        Ok(Err(err)) => Check {
            name: "camera stream",
            status: CheckStatus::Fail,
            detail: err.to_string(),
            latency_ms: started.elapsed().as_millis(),
        },
        Err(_) => Check {
            name: "camera stream",
            status: CheckStatus::Fail,
            detail: "timeout".to_string(),
            latency_ms: started.elapsed().as_millis(),
        },
    }
}

async fn telemetry_ws_check(base: &str, timeout_ms: u64) -> Check {
    let started = Instant::now();
    let url = ws_url(base, "/ws/telemetry");
    let result = time::timeout(Duration::from_millis(timeout_ms), connect_async(&url)).await;
    match result {
        Ok(Ok((mut socket, _))) => {
            let frame = time::timeout(Duration::from_millis(timeout_ms), socket.next()).await;
            match frame {
                Ok(Some(Ok(message))) if message.is_text() => {
                    let text = message.into_text().unwrap_or_default();
                    let body = serde_json::from_str::<Value>(&text).unwrap_or(Value::Null);
                    let robot = body
                        .get("robot")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown");
                    Check {
                        name: "telemetry websocket",
                        status: CheckStatus::Pass,
                        detail: format!("frame robot={robot}"),
                        latency_ms: started.elapsed().as_millis(),
                    }
                }
                Ok(Some(Ok(message))) => Check {
                    name: "telemetry websocket",
                    status: CheckStatus::Fail,
                    detail: format!("expected text frame, got {message:?}"),
                    latency_ms: started.elapsed().as_millis(),
                },
                Ok(Some(Err(err))) => Check {
                    name: "telemetry websocket",
                    status: CheckStatus::Fail,
                    detail: err.to_string(),
                    latency_ms: started.elapsed().as_millis(),
                },
                Ok(None) => Check {
                    name: "telemetry websocket",
                    status: CheckStatus::Fail,
                    detail: "socket closed before telemetry frame".to_string(),
                    latency_ms: started.elapsed().as_millis(),
                },
                Err(_) => Check {
                    name: "telemetry websocket",
                    status: CheckStatus::Fail,
                    detail: "timeout waiting for telemetry frame".to_string(),
                    latency_ms: started.elapsed().as_millis(),
                },
            }
        }
        Ok(Err(err)) => Check {
            name: "telemetry websocket",
            status: CheckStatus::Fail,
            detail: err.to_string(),
            latency_ms: started.elapsed().as_millis(),
        },
        Err(_) => Check {
            name: "telemetry websocket",
            status: CheckStatus::Fail,
            detail: "timeout connecting".to_string(),
            latency_ms: started.elapsed().as_millis(),
        },
    }
}

async fn stop_check(client: &Client, base: &str, timeout_ms: u64) -> Check {
    let started = Instant::now();
    let body = json!({});
    let result = time::timeout(
        Duration::from_millis(timeout_ms),
        client
            .post(format!("{base}/motors/stop"))
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body.to_string())
            .send(),
    )
    .await;
    match result {
        Ok(Ok(response)) => {
            let status = response.status();
            Check {
                name: "motors stop",
                status: if status.is_success() {
                    CheckStatus::Pass
                } else {
                    CheckStatus::Fail
                },
                detail: format!("HTTP {}", status.as_u16()),
                latency_ms: started.elapsed().as_millis(),
            }
        }
        Ok(Err(err)) => Check {
            name: "motors stop",
            status: CheckStatus::Fail,
            detail: err.to_string(),
            latency_ms: started.elapsed().as_millis(),
        },
        Err(_) => Check {
            name: "motors stop",
            status: CheckStatus::Fail,
            detail: "timeout".to_string(),
            latency_ms: started.elapsed().as_millis(),
        },
    }
}

fn probe_detail(probe: &Probe) -> String {
    if let Some(body) = &probe.body {
        let compact = serde_json::to_string(body).unwrap_or_else(|_| String::from("{}"));
        return match probe.status {
            Some(status) => format!("HTTP {status}: {}", trim_detail(&compact)),
            None => trim_detail(&compact),
        };
    }
    if let Some(status) = probe.status {
        return format!(
            "HTTP {status}: {}",
            trim_detail(probe.error.as_deref().unwrap_or("empty response"))
        );
    }
    probe
        .error
        .clone()
        .unwrap_or_else(|| "unknown error".to_string())
}

fn print_human(report: &Report) {
    println!(
        "rover deploy check: {}",
        if report.ok { "PASS" } else { "FAIL" }
    );
    for bot in &report.bots {
        println!();
        println!(
            "{} {} {}",
            if bot.ok { "PASS" } else { "FAIL" },
            bot.name,
            bot.url
        );
        for check in &bot.checks {
            println!(
                "  {:<5} {:<22} {:>4}ms  {}",
                status_label(check.status),
                check.name,
                check.latency_ms,
                check.detail
            );
        }
        if !bot.ok {
            println!("  reset: {}", bot.reset_command);
        }
    }
}

fn status_label(status: CheckStatus) -> &'static str {
    match status {
        CheckStatus::Pass => "pass",
        CheckStatus::Warn => "warn",
        CheckStatus::Fail => "fail",
    }
}

fn reset_command(opts: &Opts, bot: &Bot) -> String {
    let host = host_from_url(&bot.url).unwrap_or_else(|| "ROBOT_IP".to_string());
    format!(
        "./robot-harness/deploy/reset-jetson-over-ssh.sh {}@{} --repo-dir {} --role {} --sidecar-url {}",
        opts.ssh_user, host, opts.jetson_repo_dir, bot.name, opts.sidecar_url
    )
}

fn host_from_url(url: &str) -> Option<String> {
    let without_scheme = url.split_once("://").map(|(_, rest)| rest).unwrap_or(url);
    let host_port = without_scheme.split('/').next()?;
    Some(host_port.split(':').next()?.to_string())
}

fn ws_url(base: &str, path: &str) -> String {
    format!(
        "{}{}",
        base.replace("https://", "wss://")
            .replace("http://", "ws://"),
        path
    )
}

fn normalize_http_url(value: &str) -> String {
    value.trim_end_matches('/').to_string()
}

fn trim_detail(value: &str) -> String {
    const MAX: usize = 220;
    if value.len() <= MAX {
        return value.to_string();
    }
    format!("{}...", &value[..MAX])
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}
