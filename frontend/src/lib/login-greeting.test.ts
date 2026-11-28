import { describe, expect, it } from 'vitest'
import { greetingKey } from './login-greeting'

describe('login greeting', () => {
  it.each([[0, 'login.night'], [4, 'login.night'], [5, 'login.morning'], [9, 'login.morning'], [10, 'login.day'], [17, 'login.day'], [18, 'login.evening'], [21, 'login.evening'], [22, 'login.night'], [23, 'login.night']])('uses the right greeting at hour %i', (hour, expected) => {
    expect(greetingKey(hour as number)).toBe(expected)
  })
})
