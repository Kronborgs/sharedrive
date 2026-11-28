export function greetingKey(hour: number): 'login.morning' | 'login.day' | 'login.evening' | 'login.night' {
  if (hour >= 5 && hour < 10) return 'login.morning'
  if (hour >= 10 && hour < 18) return 'login.day'
  if (hour >= 18 && hour < 22) return 'login.evening'
  return 'login.night'
}
