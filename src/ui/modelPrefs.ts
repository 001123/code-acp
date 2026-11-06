/** What codeAcp.providers says about an agent's models, as the webviews get it. */
export interface ModelPrefs {
  readonly hiddenModels?: ReadonlyArray<string>;
  readonly modelOrder?: ReadonlyArray<string>;
}

/** `models` in the order of `prefs.modelOrder`, those it leaves out after them in their own order. */
export function orderModels<T extends { value: string }>(models: ReadonlyArray<T>, prefs: ModelPrefs): T[] {
  const order = prefs.modelOrder ?? [];
  if (!order.length) return [...models];
  const rank = (value: string) => {
    const i = order.indexOf(value);
    return i < 0 ? order.length : i;
  };
  return models
    .map((model, i) => ({ model, i }))
    .sort((a, b) => rank(a.model.value) - rank(b.model.value) || a.i - b.i)
    .map(({ model }) => model);
}

/** Whether the picker leaves the model `value` out. */
export const isHidden = (prefs: ModelPrefs, value: string): boolean => !!prefs.hiddenModels?.includes(value);
