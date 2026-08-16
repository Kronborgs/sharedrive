import { describe, expect, it } from 'vitest'
import { summarizeRoomReactions } from './rooms'

describe('summarizeRoomReactions', () => {
  it('groups identical emojis and preserves every distinct display name', () => {
    const result = summarizeRoomReactions([
      { user_id: 'u1', emoji: '🎉', display_name: 'Kenneth' },
      { guest_session_id: 'g1', emoji: '🎉', display_name: 'Testeren' },
      { user_id: 'u2', emoji: '👍', display_name: 'Anna' },
    ])

    expect(result).toEqual([
      { emoji: '🎉', count: 2, names: ['Kenneth', 'Testeren'] },
      { emoji: '👍', count: 1, names: ['Anna'] },
    ])
  })

  it('uses a safe label for older responses without a display name', () => {
    expect(summarizeRoomReactions([{ emoji: '❤️', display_name: '' }])).toEqual([
      { emoji: '❤️', count: 1, names: ['Ukendt bruger'] },
    ])
  })
})
