import { useState } from 'react'
import { useCameras, useCreateCamera, useDeleteCamera } from '../hooks/useCameras'

export default function Cameras() {
  const { data: cameras, isLoading } = useCameras()
  const createCamera = useCreateCamera()
  const deleteCamera = useDeleteCamera()

  const [form, setForm] = useState({ name: '', location: '', streamUrl: '' })
  const [showForm, setShowForm] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    await createCamera.mutateAsync(form)
    setForm({ name: '', location: '', streamUrl: '' })
    setShowForm(false)
  }

  if (isLoading) return <div className="text-gray-500">Loading...</div>

  return (
    <div className="max-w-3xl">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">Camera Management</h1>
        <button
          onClick={() => setShowForm(!showForm)}
          className="bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded-lg text-sm font-medium"
        >
          + Add camera
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleSubmit} className="bg-gray-900 border border-gray-800 rounded-xl p-6 mb-6 space-y-4">
          <h2 className="font-semibold">New camera</h2>
          <div>
            <label className="block text-sm text-gray-400 mb-1">Name</label>
            <input
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm"
              placeholder="E17 Kortrijk"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">Location</label>
            <input
              required
              value={form.location}
              onChange={(e) => setForm({ ...form, location: e.target.value })}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm"
              placeholder="Kortrijk"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">Stream URL (from verkeerscentrum.be)</label>
            <input
              required
              value={form.streamUrl}
              onChange={(e) => setForm({ ...form, streamUrl: e.target.value })}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm font-mono"
              placeholder="https://www.verkeerscentrum.be/camerabeelden/..."
            />
          </div>
          <div className="flex gap-3">
            <button type="submit" disabled={createCamera.isPending} className="bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded-lg text-sm font-medium">
              {createCamera.isPending ? 'Saving...' : 'Save'}
            </button>
            <button type="button" onClick={() => setShowForm(false)} className="px-4 py-2 rounded-lg text-sm text-gray-400 hover:text-white">
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="space-y-3">
        {cameras?.map((cam) => (
          <div key={cam.id} className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex justify-between items-center">
            <div>
              <p className="font-medium">{cam.name}</p>
              <p className="text-sm text-gray-400">{cam.location}</p>
              {cam.maxSpeedKmh && (
                <p className="text-xs text-orange-400 mt-1">Max speed: {cam.maxSpeedKmh} km/u</p>
              )}
            </div>
            <div className="flex gap-2">
              <a
                href={`/cameras/${cam.id}/calibrate`}
                className="text-sm text-gray-400 hover:text-white px-3 py-1 rounded-lg border border-gray-700 hover:border-gray-500"
              >
                Calibrate
              </a>
              <button
                onClick={() => deleteCamera.mutate(cam.id)}
                className="text-sm text-red-400 hover:text-red-300 px-3 py-1 rounded-lg border border-red-900 hover:border-red-700"
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
