export function chatDayKey(value: string): string {
  const date = new Date(value)
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

function isToday(value: string): boolean {
  return chatDayKey(value) === chatDayKey(new Date().toISOString())
}

function localeName(locale: string): string {
  return locale === 'da' ? 'da-DK' : 'en-US'
}

function formatTime(value: string, locale: string): string {
  return new Intl.DateTimeFormat(localeName(locale), { hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}

export function formatChatDay(value: string, locale: string): string {
  if (isToday(value)) return locale === 'da' ? 'I dag' : 'Today'
  return new Intl.DateTimeFormat(localeName(locale), { dateStyle: 'medium' }).format(new Date(value))
}

export function formatChatMessageTime(value: string, locale: string): string {
  const time = formatTime(value, locale)
  if (isToday(value)) return locale === 'da' ? `I dag kl. ${time}` : `Today at ${time}`
  const date = new Intl.DateTimeFormat(localeName(locale), { dateStyle: 'medium' }).format(new Date(value))
  return locale === 'da' ? `${date} kl. ${time}` : `${date} at ${time}`
}