//! Basis-AMM mark oracle for OutLayer TEE workers (Intel TDX), built for `wasm32-wasip2`.
//!
//! Reads one JSON request on stdin, writes one JSON response on stdout.
//!
//! * `{"mode":"pubkey"}` returns the ed25519 public key this program signs with. The basis-core
//!   contract requests this through OutLayer with the WASM hash pinned and registers the key as a
//!   TEE-attested reporter in the callback.
//! * `{"mode":"mark", ...}` fetches the order books for a market from the Polymarket CLOB, checks
//!   every outcome's mid against a second source (Gamma API prices), and returns a signed MARK
//!   report whose digest is byte-identical to `basis-core`'s `report_digest`.
//!
//! The signing key is derived from `PROTECTED_ORACLE_KEY`, an OutLayer PROTECTED secret: generated
//! inside the TEE, bound to this WASM, never seen by any person. The program never prints it.
//! Attestation proves this code produced the signature; it does not prove the venue told the
//! truth, which is why the second-source check and the contract's freshness/spread guards exist.

use borsh::BorshSerialize;
use ed25519_dalek::{Signer, SigningKey};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};

// ---------------------------------------------------------------- report layout (must match contract)

#[derive(BorshSerialize, Clone, Copy)]
#[borsh(use_discriminant = true)]
#[repr(u8)]
pub enum ReportKind {
    Mark = 0,
}

#[derive(BorshSerialize, Clone, Copy)]
#[borsh(use_discriminant = true)]
#[repr(u8)]
pub enum VenueStatus {
    Open = 0,
}

#[derive(BorshSerialize, Clone, Debug, PartialEq)]
pub struct BookLevel {
    pub price: u128,
    pub size: u128,
}

#[derive(BorshSerialize, Clone, Debug)]
pub struct OutcomeBook {
    pub outcome_id: u8,
    pub bids: Vec<BookLevel>,
    pub asks: Vec<BookLevel>,
}

#[derive(BorshSerialize, Clone)]
pub struct OracleReport {
    pub kind: ReportKind,
    pub report_id: String,
    pub market_id: String,
    pub source_chain: String,
    pub observed_block: u64,
    pub source_timestamp_ns: u64,
    pub fetch_timestamp_ns: u64,
    pub valid_until_ns: u64,
    pub outcomes: Vec<OutcomeBook>,
    pub fee_schedule_version: u32,
    pub tick_size: u128,
    pub market_status: VenueStatus,
    pub final_scenario: Option<u8>,
    pub source_hash: String,
    pub attestation_ref: String,
}

impl OracleReport {
    pub fn to_json(&self) -> Value {
        let lv = |v: &Vec<BookLevel>| -> Value {
            Value::Array(v.iter().map(|l| json!({"price": l.price.to_string(), "size": l.size.to_string()})).collect())
        };
        json!({
            "kind": "Mark",
            "report_id": self.report_id,
            "market_id": self.market_id,
            "source_chain": self.source_chain,
            "observed_block": self.observed_block.to_string(),
            "source_timestamp_ns": self.source_timestamp_ns.to_string(),
            "fetch_timestamp_ns": self.fetch_timestamp_ns.to_string(),
            "valid_until_ns": self.valid_until_ns.to_string(),
            "outcomes": self.outcomes.iter().map(|o| json!({"outcome_id": o.outcome_id, "bids": lv(&o.bids), "asks": lv(&o.asks)})).collect::<Vec<_>>(),
            "fee_schedule_version": self.fee_schedule_version,
            "tick_size": self.tick_size.to_string(),
            "market_status": "Open",
            "final_scenario": Value::Null,
            "source_hash": self.source_hash,
            "attestation_ref": self.attestation_ref,
        })
    }
}

/// `sha256("BASIS_AMM_ORACLE_V1" || contract_id || borsh(report))`, as in the contract.
pub fn report_digest(contract_id: &str, r: &OracleReport) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"BASIS_AMM_ORACLE_V1");
    h.update(contract_id.as_bytes());
    h.update(borsh::to_vec(r).expect("borsh"));
    h.finalize().into()
}

/// Domain-separated signing key from the TEE-generated secret.
pub fn signing_key(secret_hex: &str) -> Result<SigningKey, String> {
    let raw = hex::decode(secret_hex.trim()).map_err(|_| "PROTECTED_ORACLE_KEY must be hex".to_string())?;
    if raw.len() < 32 {
        return Err("PROTECTED_ORACLE_KEY must be at least 32 bytes".into());
    }
    let mut h = Sha256::new();
    h.update(b"basis-amm-oracle-key-v1");
    h.update(&raw);
    Ok(SigningKey::from_bytes(&h.finalize().into()))
}

// ---------------------------------------------------------------- request handling

#[derive(Deserialize)]
pub struct OutcomeRef {
    pub outcome_id: u8,
    pub token_id: String,
}

#[derive(Deserialize)]
pub struct RawBook {
    pub outcome_id: u8,
    /// `[price, size]` decimal strings, as returned by the CLOB.
    pub bids: Vec<(String, String)>,
    pub asks: Vec<(String, String)>,
}

#[derive(Deserialize)]
pub struct MarkRequest {
    pub contract_id: String,
    pub market_id: String,
    pub outcomes: Vec<OutcomeRef>,
    #[serde(default = "default_tick")]
    pub tick_size: String,
    #[serde(default = "default_valid")]
    pub valid_for_s: u64,
    #[serde(default = "default_levels")]
    pub levels: usize,
    /// Largest allowed |book mid - second-source price|, bps of $1.
    #[serde(default = "default_div")]
    pub max_divergence_bps: u64,
    /// Offline/test only: books and reference prices supplied by the caller instead of fetched.
    /// A report built this way is labeled `offline-input` in `source_chain`.
    pub books: Option<Vec<RawBook>>,
    pub reference_prices: Option<Vec<String>>,
    pub now_ns: Option<u64>,
}

fn default_tick() -> String {
    "10000".into()
}
fn default_valid() -> u64 {
    60
}
fn default_levels() -> usize {
    5
}
fn default_div() -> u64 {
    300
}

/// Parse a decimal string ("0.52", "1234.5") into 6-decimal fixed point.
pub fn fixed6(s: &str) -> Result<u128, String> {
    let s = s.trim();
    let (w, f) = s.split_once('.').unwrap_or((s, ""));
    if w.is_empty() && f.is_empty() || !w.chars().all(|c| c.is_ascii_digit()) || !f.chars().all(|c| c.is_ascii_digit()) {
        return Err(format!("bad decimal {s}"));
    }
    let frac: String = format!("{f:0<6}").chars().take(6).collect();
    let w: u128 = if w.is_empty() { 0 } else { w.parse().map_err(|_| format!("bad decimal {s}"))? };
    Ok(w * 1_000_000 + frac.parse::<u128>().unwrap_or(0))
}

fn levels(raw: &[(String, String)], ascending: bool, n: usize) -> Result<Vec<BookLevel>, String> {
    let mut v = raw
        .iter()
        .map(|(p, s)| Ok(BookLevel { price: fixed6(p)?, size: fixed6(s)? }))
        .collect::<Result<Vec<_>, String>>()?;
    v.retain(|l| l.price > 0 && l.price < 1_000_000 && l.size > 0);
    v.sort_by(|a, b| if ascending { a.price.cmp(&b.price) } else { b.price.cmp(&a.price) });
    v.truncate(n);
    Ok(v)
}

/// Network access, injectable so the logic is testable natively.
pub trait Http {
    fn get(&mut self, url: &str) -> Result<String, String>;
}

pub fn build_mark(req: &MarkRequest, http: &mut dyn Http, now_ns: u64, attestation_ref: &str) -> Result<OracleReport, String> {
    let mut raw_payloads: Vec<String> = vec![];
    let (raw_books, refs, offline) = match (&req.books, &req.reference_prices) {
        (Some(b), Some(r)) => (b.iter().map(|x| (x.outcome_id, x.bids.clone(), x.asks.clone())).collect::<Vec<_>>(), r.clone(), true),
        _ => {
            let mut books = vec![];
            for o in &req.outcomes {
                let body = http.get(&format!("https://clob.polymarket.com/book?token_id={}", o.token_id))?;
                let v: Value = serde_json::from_str(&body).map_err(|e| format!("clob json: {e}"))?;
                let side = |k: &str| -> Vec<(String, String)> {
                    v[k].as_array()
                        .map(|a| a.iter().filter_map(|l| Some((l["price"].as_str()?.to_string(), l["size"].as_str()?.to_string()))).collect())
                        .unwrap_or_default()
                };
                books.push((o.outcome_id, side("bids"), side("asks")));
                raw_payloads.push(body);
            }
            // Second, independent endpoint: the Gamma API's last outcome prices for the same tokens.
            let ids: Vec<&str> = req.outcomes.iter().map(|o| o.token_id.as_str()).collect();
            // Gamma takes one token id; every outcome token of a market resolves to the same row.
            let body = http.get(&format!("https://gamma-api.polymarket.com/markets?clob_token_ids={}", ids[0]))?;
            let v: Value = serde_json::from_str(&body).map_err(|e| format!("gamma json: {e}"))?;
            let m = v.as_array().and_then(|a| a.first()).ok_or("gamma: market not found")?;
            let parse = |x: &Value| -> Vec<String> {
                match x {
                    Value::String(s) => serde_json::from_str(s).unwrap_or_default(),
                    Value::Array(a) => a.iter().filter_map(|y| y.as_str().map(String::from)).collect(),
                    _ => vec![],
                }
            };
            let tokens = parse(&m["clobTokenIds"]);
            let prices = parse(&m["outcomePrices"]);
            let refs = ids
                .iter()
                .map(|id| tokens.iter().position(|t| t == id).and_then(|i| prices.get(i).cloned()).ok_or(format!("gamma: no price for {id}")))
                .collect::<Result<Vec<_>, String>>()?;
            raw_payloads.push(body);
            (books, refs, false)
        }
    };
    if raw_books.len() != req.outcomes.len() || refs.len() != req.outcomes.len() {
        return Err("outcome count mismatch".into());
    }
    let mut outcomes = vec![];
    for ((id, bids, asks), reference) in raw_books.iter().zip(&refs) {
        let bids = levels(bids, false, req.levels)?;
        let asks = levels(asks, true, req.levels)?;
        let (Some(b), Some(a)) = (bids.first(), asks.first()) else { return Err(format!("EMPTY_BOOK outcome {id}")) };
        if b.price > a.price {
            return Err(format!("CROSSED_BOOK outcome {id}"));
        }
        let mid = (b.price + a.price) / 2;
        let r = fixed6(reference)?;
        let div_bps = mid.abs_diff(r) * 10_000 / 1_000_000;
        if div_bps as u64 > req.max_divergence_bps {
            return Err(format!("SECOND_SOURCE_DIVERGENCE outcome {id}: book mid {mid} vs reference {r}"));
        }
        outcomes.push(OutcomeBook { outcome_id: *id, bids, asks });
    }
    let mut h = Sha256::new();
    for p in &raw_payloads {
        h.update(p.as_bytes());
    }
    if offline {
        h.update(serde_json::to_vec(&refs).unwrap_or_default());
    }
    Ok(OracleReport {
        kind: ReportKind::Mark,
        report_id: format!("tee-mark-{}-{}", req.market_id, now_ns),
        market_id: req.market_id.clone(),
        source_chain: if offline { "polygon:137:polymarket-clob:offline-input".into() } else { "polygon:137:polymarket-clob".into() },
        observed_block: 0,
        source_timestamp_ns: now_ns,
        fetch_timestamp_ns: now_ns,
        valid_until_ns: now_ns + req.valid_for_s * 1_000_000_000,
        outcomes,
        fee_schedule_version: 1,
        tick_size: req.tick_size.parse().map_err(|_| "bad tick")?,
        market_status: VenueStatus::Open,
        final_scenario: None,
        source_hash: hex::encode(h.finalize()),
        attestation_ref: attestation_ref.to_string(),
    })
}

pub fn handle(input: &str, secret: Option<String>, http: &mut dyn Http, now_ns: u64, attestation_ref: &str) -> Value {
    let v: Value = match serde_json::from_str(input) {
        Ok(v) => v,
        Err(e) => return json!({"ok": false, "error": format!("BAD_INPUT: {e}")}),
    };
    let key = match secret.as_deref().map(signing_key) {
        Some(Ok(k)) => k,
        Some(Err(e)) => return json!({"ok": false, "error": e}),
        None => return json!({"ok": false, "error": "PROTECTED_ORACLE_KEY not available"}),
    };
    let public_key = hex::encode(key.verifying_key().to_bytes());
    match v["mode"].as_str() {
        Some("pubkey") => json!({"ok": true, "public_key": public_key, "scheme": "ed25519", "program": "basis-amm-oracle-tee/0.1"}),
        Some("mark") => {
            let req: MarkRequest = match serde_json::from_value(v.clone()) {
                Ok(r) => r,
                Err(e) => return json!({"ok": false, "error": format!("BAD_INPUT: {e}")}),
            };
            let now = req.now_ns.unwrap_or(now_ns);
            match build_mark(&req, http, now, attestation_ref) {
                Ok(r) => {
                    let sig = key.sign(&report_digest(&req.contract_id, &r));
                    json!({"ok": true, "signed": {"report": r.to_json(), "public_key": public_key, "signature": hex::encode(sig.to_bytes())}})
                }
                Err(e) => json!({"ok": false, "error": e}),
            }
        }
        _ => json!({"ok": false, "error": "mode must be pubkey or mark"}),
    }
}

// ---------------------------------------------------------------- entry point

#[cfg(all(target_arch = "wasm32", target_os = "wasi"))]
struct WasiHttp;

#[cfg(all(target_arch = "wasm32", target_os = "wasi"))]
impl Http for WasiHttp {
    fn get(&mut self, url: &str) -> Result<String, String> {
        let resp = wasi_http_client::Client::new()
            .get(url)
            .header("user-agent", "basis-amm-oracle-tee/0.1")
            .connect_timeout(std::time::Duration::from_secs(5))
            .send()
            .map_err(|e| format!("http: {e}"))?;
        if resp.status() != 200 {
            return Err(format!("http status {} for {url}", resp.status()));
        }
        String::from_utf8(resp.body().map_err(|e| format!("http body: {e}"))?).map_err(|e| e.to_string())
    }
}

#[cfg(not(all(target_arch = "wasm32", target_os = "wasi")))]
struct NoHttp;

#[cfg(not(all(target_arch = "wasm32", target_os = "wasi")))]
impl Http for NoHttp {
    fn get(&mut self, url: &str) -> Result<String, String> {
        Err(format!("native build has no network; supply books and reference_prices ({url})"))
    }
}

fn main() {
    let mut input = String::new();
    let _ = std::io::stdin().read_to_string(&mut input);
    let now_ns = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let attestation_ref = format!(
        "outlayer-tdx:sender={}:block={}",
        std::env::var("NEAR_SENDER_ID").unwrap_or_else(|_| "offchain".into()),
        std::env::var("NEAR_BLOCK_HEIGHT").unwrap_or_else(|_| "0".into())
    );
    #[cfg(all(target_arch = "wasm32", target_os = "wasi"))]
    let mut http = WasiHttp;
    #[cfg(not(all(target_arch = "wasm32", target_os = "wasi")))]
    let mut http = NoHttp;
    let out = handle(&input, std::env::var("PROTECTED_ORACLE_KEY").ok(), &mut http, now_ns, &attestation_ref);
    let mut stdout = std::io::stdout();
    let _ = stdout.write_all(out.to_string().as_bytes());
    let _ = stdout.flush();
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fake(Vec<(String, String)>);
    impl Http for Fake {
        fn get(&mut self, url: &str) -> Result<String, String> {
            self.0.iter().find(|(k, _)| url.contains(k.as_str())).map(|(_, v)| v.clone()).ok_or(format!("unexpected {url}"))
        }
    }

    const SECRET: &str = "11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff";

    fn request(div: u64) -> String {
        json!({"mode": "mark", "contract_id": "core.test.near", "market_id": "pm-btc", "max_divergence_bps": div,
               "outcomes": [{"outcome_id": 0, "token_id": "111"}, {"outcome_id": 1, "token_id": "222"}]})
        .to_string()
    }

    fn fake() -> Fake {
        Fake(vec![
            ("token_id=111".into(), r#"{"bids":[{"price":"0.48","size":"900"},{"price":"0.49","size":"1000"}],"asks":[{"price":"0.51","size":"800"},{"price":"0.50","size":"700"}]}"#.into()),
            ("token_id=222".into(), r#"{"bids":[{"price":"0.50","size":"500"}],"asks":[{"price":"0.51","size":"500"}]}"#.into()),
            ("gamma-api".into(), r#"[{"clobTokenIds":"[\"111\",\"222\"]","outcomePrices":"[\"0.495\",\"0.505\"]"}]"#.into()),
        ])
    }

    #[test]
    fn fixed_point_parsing() {
        assert_eq!(fixed6("0.52").unwrap(), 520_000);
        assert_eq!(fixed6("1234.5").unwrap(), 1_234_500_000);
        assert_eq!(fixed6("7").unwrap(), 7_000_000);
        assert!(fixed6("-1").is_err());
        assert!(fixed6("1e5").is_err());
    }

    #[test]
    fn pubkey_mode_is_deterministic_and_hides_secret() {
        let a = handle(r#"{"mode":"pubkey"}"#, Some(SECRET.into()), &mut fake(), 1, "t");
        let b = handle(r#"{"mode":"pubkey"}"#, Some(SECRET.into()), &mut fake(), 2, "t");
        assert_eq!(a["public_key"], b["public_key"]);
        assert!(!a.to_string().contains(SECRET));
        let none = handle(r#"{"mode":"pubkey"}"#, None, &mut fake(), 1, "t");
        assert_eq!(none["ok"], false);
    }

    #[test]
    fn fetched_mark_sorts_books_and_signs() {
        let out = handle(&request(300), Some(SECRET.into()), &mut fake(), 1_700_000_000_000_000_000, "t");
        assert_eq!(out["ok"], true, "{out}");
        let r = &out["signed"]["report"];
        assert_eq!(r["outcomes"][0]["bids"][0]["price"], "490000");
        assert_eq!(r["outcomes"][0]["asks"][0]["price"], "500000");
        assert_eq!(r["source_chain"], "polygon:137:polymarket-clob");
    }

    #[test]
    fn refuses_to_sign_when_second_source_disagrees() {
        let mut f = fake();
        // Second source says YES is at $0.40 while the book mid is $0.495: 950 bps apart.
        f.0[2].1 = r#"[{"clobTokenIds":"[\"111\",\"222\"]","outcomePrices":"[\"0.40\",\"0.60\"]"}]"#.into();
        let out = handle(&request(300), Some(SECRET.into()), &mut f, 1, "t");
        assert_eq!(out["ok"], false);
        assert!(out["error"].as_str().unwrap().starts_with("SECOND_SOURCE_DIVERGENCE"));
    }

    /// The digest this program signs is byte-identical to the contract's, and the contract's
    /// ed25519 verification accepts the signature.
    #[test]
    fn digest_and_signature_match_basis_core() {
        let out = handle(&request(300), Some(SECRET.into()), &mut fake(), 1_700_000_000_000_000_000, "t");
        let signed: basis_core::types::SignedReport = serde_json::from_value(out["signed"].clone()).unwrap();
        let contract: near_sdk::AccountId = "core.test.near".parse().unwrap();
        let theirs = basis_core::oracle::report_digest(&contract, &signed.report);
        let req: MarkRequest = serde_json::from_str(&request(300)).unwrap();
        let ours = report_digest("core.test.near", &build_mark(&req, &mut fake(), 1_700_000_000_000_000_000, "t").unwrap());
        assert_eq!(theirs, ours);
        let pk: [u8; 32] = hex::decode(&signed.public_key).unwrap().try_into().unwrap();
        let sig: [u8; 64] = hex::decode(&signed.signature).unwrap().try_into().unwrap();
        assert!(near_sdk::env::ed25519_verify(&sig, theirs, &pk));
    }
}
