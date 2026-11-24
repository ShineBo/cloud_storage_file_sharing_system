const browserTime = new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).resolvedOptions();
const browserLocale = new Intl.Locale(browserTime.locale);
const englishLocale = browserLocale.language === "en" ? browserLocale.toString()
  : browserLocale.region ? `en-${browserLocale.region}` : "en";

export const localDateTime = new Intl.DateTimeFormat(englishLocale, {
  dateStyle: "medium",
  timeStyle: "short",
  hourCycle: browserTime.hourCycle,
});
