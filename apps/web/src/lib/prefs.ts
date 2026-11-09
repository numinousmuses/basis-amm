/** Local UI preferences (browser only, never sent anywhere). */
export interface Prefs {
  partialFillsDefault: boolean;
  confirmBeforeOpen: boolean;
  slippageBps: number;
  advancedRisk: boolean;
}

const DEFAULTS: Prefs = { partialFillsDefault: true, confirmBeforeOpen: true, slippageBps: 200, advancedRisk: true };

export function loadPrefs(): Prefs {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem("basis.prefs") ?? "{}") };
  } catch {
    return DEFAULTS;
  }
}

export function savePrefs(p: Prefs) {
  localStorage.setItem("basis.prefs", JSON.stringify(p));
}
