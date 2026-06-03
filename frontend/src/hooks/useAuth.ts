import { useState } from 'react'

const TOKEN_KEY = 'flash_token'

function readToken(): string | null {
  const raw = localStorage.getItem(TOKEN_KEY)
  if (!raw) return null
  try {
    const payload = JSON.parse(atob(raw.split('.')[1]))
    if (payload.exp && payload.exp * 1000 < Date.now()) {
      localStorage.removeItem(TOKEN_KEY)
      return null
    }
  } catch {
    localStorage.removeItem(TOKEN_KEY)
    return null
  }
  return raw
}

export function useAuth() {
  const [token, setToken] = useState<string | null>(() => readToken())

  async function login(pin: string) {
    const res = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin }),
    })
    if (!res.ok) throw new Error('Invalid PIN')
    const { token: newToken } = await res.json() as { token: string }
    localStorage.setItem(TOKEN_KEY, newToken)
    setToken(newToken)
  }

  function logout() {
    localStorage.removeItem(TOKEN_KEY)
    setToken(null)
  }

  return { isAuthenticated: token !== null, login, logout }
}
