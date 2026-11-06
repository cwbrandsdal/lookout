/** Keep single-line clipboard text editable until Enter, without changing multi-line pastes. */
export function preparePaste(text: string, autoSubmitSingleLinePaste: boolean): string {
  if (autoSubmitSingleLinePaste) {
    return text;
  }

  const withoutTrailingLineBreaks = text.replace(/[\r\n]+$/, '');
  return /[\r\n]/.test(withoutTrailingLineBreaks) ? text : withoutTrailingLineBreaks;
}
