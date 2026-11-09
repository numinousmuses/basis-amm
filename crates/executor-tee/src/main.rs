//! Basis-AMM hedge executor signer for OutLayer TEE workers (Intel TDX), built for `wasm32-wasip2`.
//!
//! This program holds the Polymarket session key of the vault's hedge executor. The key is derived
//! from `PROTECTED_EXECUTOR_KEY`, an OutLayer PROTECTED secret generated inside the TEE and bound
//! to this WASM, so no operator ever holds it. The Deposit Wallet Owner authorizes the derived
//! address as a Polymarket Session Key (CLOB scope), which can trade but cannot withdraw.
//!
//! The program signs exactly two EIP-712 payloads and refuses everything else:
//! * `ClobAuth` (CLOB API-key login) for its own address;
//! * `Order` on an allowlisted Polymarket exchange, signed by its own address, for a maker that is
//!   itself or the configured deposit wallet, inside hard-coded price and notional limits that a
//!   request can only tighten.
//! It never signs messages or transactions, so it cannot approve spenders, transfer collateral or
//! touch any wallet batch.
//!
//! stdin -> stdout JSON:
//! * `{"mode":"address"}` -> `{"ok":true,"address":"0x..."}`
//! * `{"mode":"sign_typed_data","payload":{domain,types,primaryType,message},"deposit_wallet"?,"limits"?,"now_ms"?}`
//!   -> `{"ok":true,"signature":"0x...","digest":"0x..."}` or `{"ok":false,"error":"POLICY: ..."}`

use k256::ecdsa::SigningKey;
use serde_json::{Value, json};
use sha2::{Digest as _, Sha256};
use sha3::Keccak256;
use std::collections::BTreeSet;
use std::io::{Read, Write};

// ---------------------------------------------------------------- policy constants

/// Polymarket exchange contracts on Polygon (docs.polymarket.com/resources/contracts).
pub const ALLOWED_EXCHANGES: [&str; 3] = [
    "0xe111180000d2663c0091e4f400237545b87b996b", // CTF Exchange
    "0xe2222d279d744050d28e00520010520000310f59", // Neg Risk CTF Exchange
    "0xe3333700ca9d93003f00f0f71f8515005f6c00aa", // Polymarket Protocol V2 Exchange
];
pub const ORDER_DOMAIN_NAMES: [&str; 2] = ["Polymarket CTF Exchange", "Polymarket Exchange"];
pub const CHAIN_ID: u64 = 137;
/// Hard cap per order in pUSD micro-units ($2,500). A request may only lower it.
pub const MAX_ORDER_NOTIONAL: u128 = 2_500_000_000;
/// Price bounds in parts per million of $1.
pub const MIN_PRICE_PPM: u128 = 10_000;
pub const MAX_PRICE_PPM: u128 = 990_000;
/// Order timestamps must be within this window of the worker's clock.
pub const MAX_CLOCK_SKEW_MS: i128 = 10 * 60 * 1000;

fn keccak(data: &[u8]) -> [u8; 32] {
    let mut h = Keccak256::new();
    h.update(data);
    h.finalize().into()
}

// ---------------------------------------------------------------- EIP-712

fn uint256_from_value(v: &Value) -> Result<[u8; 32], String> {
    let s = match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => (if *b { "1" } else { "0" }).to_string(),
        _ => return Err(format!("expected integer, got {v}")),
    };
    let mut out = [0u8; 32];
    if let Some(h) = s.strip_prefix("0x") {
        let b = hex::decode(if h.len() % 2 == 1 { format!("0{h}") } else { h.to_string() }).map_err(|_| "bad hex integer")?;
        if b.len() > 32 {
            return Err("integer overflow".into());
        }
        out[32 - b.len()..].copy_from_slice(&b);
        return Ok(out);
    }
    if s.is_empty() || !s.chars().all(|c| c.is_ascii_digit()) {
        return Err(format!("bad integer {s}"));
    }
    for c in s.bytes() {
        let mut carry = (c - b'0') as u32;
        for byte in out.iter_mut().rev() {
            let x = (*byte as u32) * 10 + carry;
            *byte = (x & 0xff) as u8;
            carry = x >> 8;
        }
        if carry != 0 {
            return Err("integer overflow".into());
        }
    }
    Ok(out)
}

fn u128_of(v: &Value) -> Result<u128, String> {
    let b = uint256_from_value(v)?;
    if b[..16].iter().any(|x| *x != 0) {
        return Err("value exceeds u128".into());
    }
    Ok(u128::from_be_bytes(b[16..].try_into().unwrap()))
}

fn fields<'a>(types: &'a Value, name: &str) -> Result<&'a Vec<Value>, String> {
    types.get(name).and_then(|v| v.as_array()).ok_or_else(|| format!("unknown type {name}"))
}

fn base_type(t: &str) -> &str {
    t.split('[').next().unwrap_or(t)
}

fn collect_deps(types: &Value, name: &str, acc: &mut BTreeSet<String>) -> Result<(), String> {
    for f in fields(types, name)? {
        let t = base_type(f["type"].as_str().ok_or("field type")?);
        if types.get(t).is_some() && t != name && acc.insert(t.to_string()) {
            collect_deps(types, t, acc)?;
        }
    }
    Ok(())
}

pub fn encode_type(types: &Value, primary: &str) -> Result<String, String> {
    let mut deps = BTreeSet::new();
    collect_deps(types, primary, &mut deps)?;
    deps.remove(primary);
    let mut out = String::new();
    for name in std::iter::once(primary.to_string()).chain(deps) {
        let fs = fields(types, &name)?
            .iter()
            .map(|f| format!("{} {}", f["type"].as_str().unwrap_or(""), f["name"].as_str().unwrap_or("")))
            .collect::<Vec<_>>()
            .join(",");
        out.push_str(&format!("{name}({fs})"));
    }
    Ok(out)
}

fn encode_value(types: &Value, t: &str, v: &Value) -> Result<[u8; 32], String> {
    if let Some(inner) = t.strip_suffix("[]") {
        let arr = v.as_array().ok_or("expected array")?;
        let mut buf = vec![];
        for item in arr {
            buf.extend_from_slice(&encode_value(types, inner, item)?);
        }
        return Ok(keccak(&buf));
    }
    if types.get(t).is_some() {
        return hash_struct(types, t, v);
    }
    match t {
        "address" => {
            let s = v.as_str().ok_or("address must be a string")?;
            let b = hex::decode(s.trim_start_matches("0x")).map_err(|_| "bad address")?;
            if b.len() != 20 {
                return Err("bad address length".into());
            }
            let mut out = [0u8; 32];
            out[12..].copy_from_slice(&b);
            Ok(out)
        }
        "bool" => {
            let mut out = [0u8; 32];
            out[31] = if v.as_bool().ok_or("bool")? { 1 } else { 0 };
            Ok(out)
        }
        "string" => Ok(keccak(v.as_str().ok_or("string")?.as_bytes())),
        "bytes" => Ok(keccak(&hex::decode(v.as_str().ok_or("bytes")?.trim_start_matches("0x")).map_err(|_| "bad bytes")?)),
        _ if t.starts_with("bytes") => {
            let b = hex::decode(v.as_str().ok_or("bytesN")?.trim_start_matches("0x")).map_err(|_| "bad bytesN")?;
            if b.len() > 32 {
                return Err("bytesN too long".into());
            }
            let mut out = [0u8; 32];
            out[..b.len()].copy_from_slice(&b);
            Ok(out)
        }
        _ if t.starts_with("uint") => uint256_from_value(v),
        _ => Err(format!("unsupported EIP-712 type {t}")),
    }
}

pub fn hash_struct(types: &Value, name: &str, data: &Value) -> Result<[u8; 32], String> {
    let mut buf = keccak(encode_type(types, name)?.as_bytes()).to_vec();
    for f in fields(types, name)? {
        let (fname, ftype) = (f["name"].as_str().ok_or("field name")?, f["type"].as_str().ok_or("field type")?);
        let v = data.get(fname).ok_or_else(|| format!("missing field {fname}"))?;
        buf.extend_from_slice(&encode_value(types, ftype, v)?);
    }
    Ok(keccak(&buf))
}

/// `keccak256(0x1901 || hashStruct(EIP712Domain, domain) || hashStruct(primaryType, message))`.
pub fn typed_data_digest(payload: &Value) -> Result<[u8; 32], String> {
    let mut types = payload["types"].clone();
    let domain = &payload["domain"];
    if types.get("EIP712Domain").is_none() {
        let mut fs = vec![];
        for (k, t) in [("name", "string"), ("version", "string"), ("chainId", "uint256"), ("verifyingContract", "address"), ("salt", "bytes32")] {
            if domain.get(k).is_some() {
                fs.push(json!({"name": k, "type": t}));
            }
        }
        types["EIP712Domain"] = Value::Array(fs);
    }
    let primary = payload["primaryType"].as_str().ok_or("primaryType")?;
    let mut buf = vec![0x19, 0x01];
    buf.extend_from_slice(&hash_struct(&types, "EIP712Domain", domain)?);
    buf.extend_from_slice(&hash_struct(&types, primary, &payload["message"])?);
    Ok(keccak(&buf))
}

// ---------------------------------------------------------------- keys

pub fn signing_key(secret_hex: &str) -> Result<SigningKey, String> {
    let raw = hex::decode(secret_hex.trim().trim_start_matches("0x")).map_err(|_| "PROTECTED_EXECUTOR_KEY must be hex")?;
    if raw.len() < 32 {
        return Err("PROTECTED_EXECUTOR_KEY must be at least 32 bytes".into());
    }
    for counter in 0u8..=255 {
        let mut h = Sha256::new();
        h.update(b"basis-amm-executor-key-v1");
        h.update(&raw);
        h.update([counter]);
        let d: [u8; 32] = h.finalize().into();
        if let Ok(k) = SigningKey::from_slice(&d) {
            return Ok(k);
        }
    }
    Err("could not derive key".into())
}

pub fn checksum_address(addr20: &[u8]) -> String {
    let lower = hex::encode(addr20);
    let h = keccak(lower.as_bytes());
    let mut out = String::from("0x");
    for (i, c) in lower.chars().enumerate() {
        let nibble = (h[i / 2] >> (if i % 2 == 0 { 4 } else { 0 })) & 0xf;
        out.push(if c.is_ascii_alphabetic() && nibble >= 8 { c.to_ascii_uppercase() } else { c });
    }
    out
}

pub fn address_of(key: &SigningKey) -> String {
    let point = key.verifying_key().to_encoded_point(false);
    checksum_address(&keccak(&point.as_bytes()[1..])[12..])
}

pub fn sign_digest(key: &SigningKey, digest: &[u8; 32]) -> Result<String, String> {
    let (sig, recid) = key.sign_prehash_recoverable(digest).map_err(|e| e.to_string())?;
    let mut out = sig.to_bytes().to_vec();
    out.push(27 + recid.to_byte());
    Ok(format!("0x{}", hex::encode(out)))
}

// ---------------------------------------------------------------- policy

fn eq_addr(a: &str, b: &str) -> bool {
    a.trim_start_matches("0x").eq_ignore_ascii_case(b.trim_start_matches("0x"))
}

#[derive(Default)]
pub struct Limits {
    pub max_notional: u128,
    pub min_price_ppm: u128,
    pub max_price_ppm: u128,
    pub token_ids: Option<Vec<String>>,
}

pub fn limits_from(v: &Value) -> Result<Limits, String> {
    let mut l = Limits { max_notional: MAX_ORDER_NOTIONAL, min_price_ppm: MIN_PRICE_PPM, max_price_ppm: MAX_PRICE_PPM, token_ids: None };
    if let Some(x) = v.get("max_notional").filter(|x| !x.is_null()) {
        l.max_notional = l.max_notional.min(u128_of(x)?);
    }
    if let Some(x) = v.get("min_price_ppm").filter(|x| !x.is_null()) {
        l.min_price_ppm = l.min_price_ppm.max(u128_of(x)?);
    }
    if let Some(x) = v.get("max_price_ppm").filter(|x| !x.is_null()) {
        l.max_price_ppm = l.max_price_ppm.min(u128_of(x)?);
    }
    if let Some(a) = v.get("token_ids").and_then(|x| x.as_array()) {
        l.token_ids = Some(a.iter().filter_map(|x| x.as_str().map(String::from)).collect());
    }
    Ok(l)
}

/// Returns Ok(()) only for payloads this executor is allowed to sign.
pub fn check_policy(payload: &Value, own: &str, deposit_wallet: Option<&str>, limits: &Limits, now_ms: Option<i128>) -> Result<(), String> {
    let d = &payload["domain"];
    let chain = d.get("chainId").map(u128_of).transpose()?.unwrap_or(0);
    if chain != CHAIN_ID as u128 {
        return Err(format!("POLICY: chainId {chain} is not Polygon"));
    }
    let m = &payload["message"];
    match payload["primaryType"].as_str().unwrap_or("") {
        "ClobAuth" => {
            if d["name"] != "ClobAuthDomain" || d["version"] != "1" {
                return Err("POLICY: unexpected ClobAuth domain".into());
            }
            if !eq_addr(m["address"].as_str().unwrap_or(""), own) {
                return Err("POLICY: ClobAuth for another address".into());
            }
            Ok(())
        }
        "Order" => {
            let name = d["name"].as_str().unwrap_or("");
            if !ORDER_DOMAIN_NAMES.contains(&name) {
                return Err(format!("POLICY: unknown exchange domain {name}"));
            }
            let vc = d["verifyingContract"].as_str().unwrap_or("");
            if !ALLOWED_EXCHANGES.iter().any(|a| eq_addr(a, vc)) {
                return Err(format!("POLICY: exchange {vc} not allowlisted"));
            }
            if !eq_addr(m["signer"].as_str().unwrap_or(""), own) {
                return Err("POLICY: order signer is not this executor".into());
            }
            let maker = m["maker"].as_str().unwrap_or("");
            let maker_ok = eq_addr(maker, own) || deposit_wallet.map(|w| eq_addr(maker, w)).unwrap_or(false);
            if !maker_ok {
                return Err("POLICY: order maker is neither this executor nor its deposit wallet".into());
            }
            if let Some(ids) = &limits.token_ids {
                let tid = m["tokenId"].as_str().map(String::from).unwrap_or_else(|| m["tokenId"].to_string());
                if !ids.contains(&tid) {
                    return Err("POLICY: token not in the request allowlist".into());
                }
            }
            let maker_amount = u128_of(&m["makerAmount"])?;
            let taker_amount = u128_of(&m["takerAmount"])?;
            if maker_amount == 0 || taker_amount == 0 {
                return Err("POLICY: zero amount".into());
            }
            let side = u128_of(&m["side"]).or_else(|_| match m["side"].as_str() {
                Some("BUY") => Ok(0),
                Some("SELL") => Ok(1),
                _ => Err("POLICY: side".to_string()),
            })?;
            // BUY: pays makerAmount pUSD for takerAmount shares. SELL: gives makerAmount shares for takerAmount pUSD.
            let (notional, price_ppm) = if side == 0 {
                (maker_amount, maker_amount * 1_000_000 / taker_amount)
            } else {
                (taker_amount, taker_amount * 1_000_000 / maker_amount)
            };
            if notional > limits.max_notional {
                return Err(format!("POLICY: notional {notional} above cap {}", limits.max_notional));
            }
            if price_ppm > limits.max_price_ppm || price_ppm < limits.min_price_ppm {
                return Err(format!("POLICY: price {price_ppm} ppm outside [{}, {}]", limits.min_price_ppm, limits.max_price_ppm));
            }
            if let (Some(now), Some(ts)) = (now_ms, m.get("timestamp")) {
                let ts = u128_of(ts)? as i128;
                if (ts - now).abs() > MAX_CLOCK_SKEW_MS {
                    return Err("POLICY: order timestamp too far from the worker clock".into());
                }
            }
            Ok(())
        }
        other => Err(format!("POLICY: refusing to sign {other}")),
    }
}

pub fn handle(input: &str, secret: Option<String>, clock_ms: Option<i128>) -> Value {
    let v: Value = match serde_json::from_str(input) {
        Ok(v) => v,
        Err(e) => return json!({"ok": false, "error": format!("BAD_INPUT: {e}")}),
    };
    let key = match secret.as_deref().map(signing_key) {
        Some(Ok(k)) => k,
        Some(Err(e)) => return json!({"ok": false, "error": e}),
        None => return json!({"ok": false, "error": "PROTECTED_EXECUTOR_KEY not available"}),
    };
    let own = address_of(&key);
    match v["mode"].as_str() {
        Some("address") => json!({"ok": true, "address": own, "program": "basis-amm-executor-tee/0.1"}),
        Some("sign_typed_data") => {
            let payload = &v["payload"];
            let limits = match limits_from(v.get("limits").unwrap_or(&Value::Null)) {
                Ok(l) => l,
                Err(e) => return json!({"ok": false, "error": e}),
            };
            let now = v.get("now_ms").and_then(|x| u128_of(x).ok()).map(|x| x as i128).or(clock_ms);
            if let Err(e) = check_policy(payload, &own, v["deposit_wallet"].as_str(), &limits, now) {
                return json!({"ok": false, "error": e});
            }
            match typed_data_digest(payload).and_then(|d| sign_digest(&key, &d).map(|s| (d, s))) {
                Ok((d, s)) => json!({"ok": true, "signature": s, "digest": format!("0x{}", hex::encode(d))}),
                Err(e) => json!({"ok": false, "error": e}),
            }
        }
        _ => json!({"ok": false, "error": "POLICY: only address and sign_typed_data are supported"}),
    }
}

fn main() {
    let mut input = String::new();
    let _ = std::io::stdin().read_to_string(&mut input);
    let clock = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_millis() as i128);
    let out = handle(&input, std::env::var("PROTECTED_EXECUTOR_KEY").ok(), clock);
    let mut o = std::io::stdout();
    let _ = o.write_all(out.to_string().as_bytes());
    let _ = o.flush();
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "abababababababababababababababababababababababababababababababab";

    fn order(own: &str, maker_amount: &str, taker_amount: &str, exchange: &str) -> Value {
        json!({
            "domain": {"chainId": 137, "name": "Polymarket CTF Exchange", "verifyingContract": exchange, "version": "2"},
            "types": {
                "EIP712Domain": [{"name":"name","type":"string"},{"name":"version","type":"string"},{"name":"chainId","type":"uint256"},{"name":"verifyingContract","type":"address"}],
                "Order": [{"name":"salt","type":"uint256"},{"name":"maker","type":"address"},{"name":"signer","type":"address"},{"name":"tokenId","type":"uint256"},{"name":"makerAmount","type":"uint256"},{"name":"takerAmount","type":"uint256"},{"name":"side","type":"uint8"},{"name":"signatureType","type":"uint8"},{"name":"timestamp","type":"uint256"},{"name":"metadata","type":"bytes32"},{"name":"builder","type":"bytes32"}]
            },
            "primaryType": "Order",
            "message": {"salt": "2902849442783494", "maker": own, "signer": own, "tokenId": "70071592420137476676935286377781779672157004436137616627487590484756055232944",
                        "makerAmount": maker_amount, "takerAmount": taker_amount, "side": 0, "signatureType": 0, "timestamp": "1794246924863",
                        "metadata": "0x0000000000000000000000000000000000000000000000000000000000000000", "builder": "0x0000000000000000000000000000000000000000000000000000000000000000"}
        })
    }

    #[test]
    fn eip712_matches_reference_vector() {
        // EIP-712 spec "Mail" example: digest 0xbe609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2.
        let p = json!({
            "types": {
                "EIP712Domain": [{"name":"name","type":"string"},{"name":"version","type":"string"},{"name":"chainId","type":"uint256"},{"name":"verifyingContract","type":"address"}],
                "Person": [{"name":"name","type":"string"},{"name":"wallet","type":"address"}],
                "Mail": [{"name":"from","type":"Person"},{"name":"to","type":"Person"},{"name":"contents","type":"string"}]
            },
            "primaryType": "Mail",
            "domain": {"name":"Ether Mail","version":"1","chainId":1,"verifyingContract":"0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC"},
            "message": {"from":{"name":"Cow","wallet":"0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826"},"to":{"name":"Bob","wallet":"0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB"},"contents":"Hello, Bob!"}
        });
        assert_eq!(hex::encode(typed_data_digest(&p).unwrap()), "be609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2");
        // Cow's key from the spec signs to the published signature.
        let cow = SigningKey::from_slice(&keccak(b"cow")).unwrap();
        assert_eq!(address_of(&cow), "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826");
        let sig = sign_digest(&cow, &typed_data_digest(&p).unwrap()).unwrap();
        assert_eq!(sig, "0x4355c47d63924e8a72e509b65029052eb6c299d53a04e167c5775fd466751c9d07299936d304c153f6443dfa05f40ff007d72911b6f72307f996231605b915621c");
    }

    #[test]
    fn signs_bounded_orders_only() {
        let key = signing_key(SECRET).unwrap();
        let own = address_of(&key);
        let ex = ALLOWED_EXCHANGES[1];
        let ok = handle(&json!({"mode":"sign_typed_data","payload": order(&own, "5000000", "5263150", ex),"now_ms":"1794246924863"}).to_string(), Some(SECRET.into()), None);
        assert_eq!(ok["ok"], true, "{ok}");
        let too_big = handle(&json!({"mode":"sign_typed_data","payload": order(&own, "3000000000", "4000000000", ex),"now_ms":"1794246924863"}).to_string(), Some(SECRET.into()), None);
        assert!(too_big["error"].as_str().unwrap().contains("notional"));
        let bad_ex = handle(&json!({"mode":"sign_typed_data","payload": order(&own, "5000000", "5263150", "0x0000000000000000000000000000000000000001"),"now_ms":"1794246924863"}).to_string(), Some(SECRET.into()), None);
        assert!(bad_ex["error"].as_str().unwrap().contains("not allowlisted"));
        let other = handle(&json!({"mode":"sign_typed_data","payload": order("0x00000000000000000000000000000000000000aa", "5000000", "5263150", ex),"now_ms":"1794246924863"}).to_string(), Some(SECRET.into()), None);
        assert_eq!(other["ok"], false);
        // Price 0.999 per share is above the 0.99 cap.
        let pricey = handle(&json!({"mode":"sign_typed_data","payload": order(&own, "999000", "1000000", ex),"now_ms":"1794246924863"}).to_string(), Some(SECRET.into()), None);
        assert!(pricey["error"].as_str().unwrap().contains("price"));
        // A request can tighten but never loosen limits.
        let tight = handle(&json!({"mode":"sign_typed_data","payload": order(&own, "5000000", "5263150", ex),"limits":{"max_notional":"1000000"},"now_ms":"1794246924863"}).to_string(), Some(SECRET.into()), None);
        assert_eq!(tight["ok"], false);
        let loose = limits_from(&json!({"max_notional":"999999999999999","max_price_ppm":"999999"})).unwrap();
        assert_eq!(loose.max_notional, MAX_ORDER_NOTIONAL);
        assert_eq!(loose.max_price_ppm, MAX_PRICE_PPM);
        // Stale timestamp.
        let stale = handle(&json!({"mode":"sign_typed_data","payload": order(&own, "5000000", "5263150", ex),"now_ms":"1894246924863"}).to_string(), Some(SECRET.into()), None);
        assert!(stale["error"].as_str().unwrap().contains("clock"));
    }

    #[test]
    fn refuses_everything_else() {
        let key = signing_key(SECRET).unwrap();
        let own = address_of(&key);
        let batch = json!({"domain":{"name":"DepositWallet","version":"1","chainId":137,"verifyingContract":own},"types":{"Batch":[{"name":"wallet","type":"address"}]},"primaryType":"Batch","message":{"wallet":own}});
        let r = handle(&json!({"mode":"sign_typed_data","payload":batch}).to_string(), Some(SECRET.into()), None);
        assert!(r["error"].as_str().unwrap().contains("refusing"));
        let r = handle(r#"{"mode":"sign_message","message":"0x00"}"#, Some(SECRET.into()), None);
        assert_eq!(r["ok"], false);
        let auth_other = json!({"domain":{"chainId":137,"name":"ClobAuthDomain","version":"1"},"types":{"ClobAuth":[{"name":"address","type":"address"},{"name":"timestamp","type":"string"},{"name":"nonce","type":"uint256"},{"name":"message","type":"string"}]},"primaryType":"ClobAuth","message":{"address":"0x00000000000000000000000000000000000000aa","timestamp":"1","nonce":0,"message":"x"}});
        let r = handle(&json!({"mode":"sign_typed_data","payload":auth_other}).to_string(), Some(SECRET.into()), None);
        assert!(r["error"].as_str().unwrap().contains("another address"));
    }
}
