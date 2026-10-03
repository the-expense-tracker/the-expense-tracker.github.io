// Checks that protect the user's data: the network lock, persistent storage,
// and a best-effort private-window warning.

// Confirms the browser is blocking network access. The test address uses the
// reserved ".invalid" domain, which never resolves, so even if the lock were
// missing, nothing would leave the computer.
export function checkNetworkLock(timeoutMs = 1500) {
  const probe = "https://network-lock-check.invalid/probe";
  return new Promise((resolve) => {
    let settled = false;
    const finish = (locked) => {
      if (settled) return;
      settled = true;
      document.removeEventListener("securitypolicyviolation", onViolation);
      resolve(locked);
    };
    const onViolation = (e) => {
      if (String(e.blockedURI || "").includes("network-lock-check.invalid")) finish(true);
    };
    document.addEventListener("securitypolicyviolation", onViolation);
    try {
      fetch(probe, { mode: "no-cors", cache: "no-store" }).then(() => finish(false), () => setTimeout(() => finish(false), 300));
    } catch {
      // A fetch that fails to start isn't proof of the lock; only the browser's
      // own "blocked by policy" report is.
      finish(false);
    }
    setTimeout(() => finish(false), timeoutMs);
  });
}

// Asks the browser to keep this site's data even when space runs low.
// Chrome and Edge decide silently; Firefox asks the user.
export async function requestPersistence() {
  if (!navigator.storage || !navigator.storage.persist) return "unsupported";
  try {
    if (await navigator.storage.persisted()) return "granted";
    return (await navigator.storage.persist()) ? "granted" : "denied";
  } catch {
    return "unsupported";
  }
}

// Private windows usually give sites a much smaller storage allowance.
// This is a hint, not a guarantee, so the warning is worded carefully.
export async function looksLikePrivateWindow() {
  if (!navigator.storage || !navigator.storage.estimate) return false;
  try {
    const { quota } = await navigator.storage.estimate();
    return typeof quota === "number" && quota > 0 && quota < 150 * 1024 * 1024;
  } catch {
    return false;
  }
}
