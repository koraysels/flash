import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useCameras, useCreateCamera, useDeleteCamera } from '../hooks/useCameras'

export default function Cameras() {
  const { data: cameras, isLoading, error } = useCameras()
  const createCamera = useCreateCamera()
  const deleteCamera = useDeleteCamera()

  const [form, setForm] = useState({ name: '', location: '', streamUrl: '' })
  const [showForm, setShowForm] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (createCamera.isPending) return
    setSubmitError(null)
    try {
      await createCamera.mutateAsync(form)
      setForm({ name: '', location: '', streamUrl: '' })
      setShowForm(false)
    } catch {
      setSubmitError('Failed to save camera.')
    }
  }

  if (isLoading) return <div className="text-xs text-stone-400 uppercase tracking-widest">Loading...</div>
  if (error) return <div className="text-xs text-red-600 uppercase tracking-widest">Failed to load cameras.</div>

  return (
    <div className="max-w-2xl">
      <div className="flex justify-between items-center mb-6">
        <p className="text-xs font-bold tracking-widest uppercase text-stone-400">Camera Management</p>
        <button
          onClick={() => setShowForm(!showForm)}
          className="text-xs uppercase tracking-widest border-2 border-black px-3 py-1.5 hover:bg-black hover:text-white transition-colors"
        >
          + Add Camera
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleSubmit} className="border-2 border-black p-5 mb-6 space-y-4">
          <p className="text-xs font-bold uppercase tracking-widest">New Camera</p>
          {submitError && <p className="text-xs text-red-600 uppercase">{submitError}</p>}
          <div>
            <label className="block text-xs uppercase tracking-widest text-stone-500 mb-1">Name</label>
            <input
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="w-full border-2 border-black px-3 py-2 text-sm focus:outline-none bg-white"
              placeholder="E17 Kortrijk"
            />
          </div>
          <div>
            <label className="block text-xs uppercase tracking-widest text-stone-500 mb-1">Location</label>
            <input
              required
              value={form.location}
              onChange={(e) => setForm({ ...form, location: e.target.value })}
              className="w-full border-2 border-black px-3 py-2 text-sm focus:outline-none bg-white"
              placeholder="Kortrijk"
            />
          </div>
          <div>
            <label className="block text-xs uppercase tracking-widest text-stone-500 mb-1">Stream URL</label>
            <input
              required
              value={form.streamUrl}
              onChange={(e) => setForm({ ...form, streamUrl: e.target.value })}
              className="w-full border-2 border-black px-3 py-2 text-sm focus:outline-none bg-white"
              placeholder="https://www.verkeerscentrum.be/camerabeelden/..."
            />
          </div>
          <div className="flex gap-3 pt-1">
            <button
              type="submit"
              disabled={createCamera.isPending}
              className="text-xs uppercase tracking-widest border-2 border-black px-4 py-2 hover:bg-black hover:text-white disabled:opacity-40 transition-colors"
            >
              {createCamera.isPending ? 'Saving...' : 'Save'}
            </button>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="text-xs uppercase tracking-widest text-stone-400 px-4 py-2 hover:text-black"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="border-2 border-black">
        {!cameras?.length && (
          <div className="px-4 py-6 text-xs text-stone-400 uppercase tracking-widest text-center">
            No cameras configured
          </div>
        )}
        {cameras?.map((cam, i) => (
          <div
            key={cam.id}
            className={`flex justify-between items-center px-4 py-3 ${i > 0 ? 'border-t-2 border-black' : ''}`}
          >
            <div>
              <p className="text-sm font-bold uppercase">{cam.name}</p>
              <p className="text-xs text-stone-500">{cam.location}</p>
              {cam.maxSpeedKmh && (
                <p className="text-xs text-stone-400 mt-0.5">MAX {cam.maxSpeedKmh} KM/H</p>
              )}
            </div>
            <div className="flex gap-2">
              <Link
                to={`/cameras/${cam.id}/calibrate`}
                className="text-xs uppercase tracking-widest border border-black px-2 py-1 hover:bg-black hover:text-white transition-colors"
              >
                Calibrate
              </Link>
              <button
                onClick={() => deleteCamera.mutate(cam.id)}
                disabled={deleteCamera.isPending}
                className="text-xs uppercase tracking-widest border border-red-600 text-red-600 px-2 py-1 hover:bg-red-600 hover:text-white disabled:opacity-40 transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
