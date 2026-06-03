import { useState, useRef, useEffect } from 'react'
import { useAuth } from '../hooks/useAuth'

export default function PinGate({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, login } = useAuth()
  const [pin, setPin] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!isAuthenticated) inputRef.current?.focus()
  }, [isAuthenticated])

  if (isAuthenticated) return <>{children}</>

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (pending) return
    setPending(true)
    setError(null)
    try {
      await login(pin)
    } catch {
      setError('Incorrect PIN')
      setPin('')
      inputRef.current?.focus()
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="min-h-screen bg-white flex items-center justify-center">
      <div className="border-2 border-black p-8 w-64">
        <p className="text-xs font-bold tracking-widest uppercase mb-6">FLASH</p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs uppercase tracking-widest text-stone-500 mb-1">PIN</label>
            <input
              ref={inputRef}
              type="password"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              className="w-full border-2 border-black px-3 py-2 text-sm focus:outline-none bg-white"
              placeholder="••••"
              inputMode="numeric"
            />
          </div>
          {error && <p className="text-xs text-red-600 uppercase">{error}</p>}
          <button
            type="submit"
            disabled={pending || !pin}
            className="w-full text-xs uppercase tracking-widest border-2 border-black px-4 py-2 hover:bg-black hover:text-white disabled:opacity-40 transition-colors"
          >
            {pending ? 'Checking...' : 'Enter'}
          </button>
        </form>
      </div>
    </div>
  )
}
