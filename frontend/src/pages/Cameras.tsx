import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useCameras, useCreateCamera, useDeleteCamera, useUpdateCamera, useDuplicateCamera } from '../hooks/useCameras'
import { CameraThumbnail } from '../components/CameraThumbnail'

export default function Cameras() {
  const { data: cameras, isLoading, error } = useCameras()
  const createCamera = useCreateCamera()
  const deleteCamera = useDeleteCamera()
  const updateCamera = useUpdateCamera()
  const duplicateCamera = useDuplicateCamera()

  const [form, setForm] = useState({ name: '', location: '', streamUrl: '' })
  const [showForm, setShowForm] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState({ name: '', location: '' })

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (createCamera.isPending) return
    setSubmitError(null)
    try {
      await createCamera.mutateAsync(form)
      setForm({ name: '', location: '', streamUrl: '' })
      setShowForm(false)
    } catch {
      setSubmitError('Camera opslaan mislukt.')
    }
  }

  function startEdit(cam: { id: string; name: string; location: string }) {
    setEditingId(cam.id)
    setEditForm({ name: cam.name, location: cam.location })
  }

  async function saveEdit(id: string) {
    await updateCamera.mutateAsync({ id, data: editForm })
    setEditingId(null)
  }

  function cancelEdit() {
    setEditingId(null)
  }

  if (isLoading) return <div className="text-xs text-stone-400 uppercase tracking-widest">Laden…</div>
  if (error) return <div className="text-xs text-red-600 uppercase tracking-widest">Camera's laden mislukt.</div>

  return (
    <div className="max-w-4xl">
      <div className="flex justify-between items-center mb-6">
        <p className="text-xs font-bold tracking-widest uppercase text-stone-400">Camera-beheer</p>
        <button
          onClick={() => setShowForm(!showForm)}
          className="text-xs uppercase tracking-widest border-2 border-black px-3 py-1.5 hover:bg-black hover:text-white transition-colors"
        >
          + Camera toevoegen
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleSubmit} className="border-2 border-black p-5 mb-6 space-y-4">
          <p className="text-xs font-bold uppercase tracking-widest">Nieuwe camera</p>
          {submitError && <p className="text-xs text-red-600 uppercase">{submitError}</p>}
          <div>
            <label className="block text-xs uppercase tracking-widest text-stone-500 mb-1">Naam</label>
            <input
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="w-full border-2 border-black px-3 py-2 text-sm focus:outline-none bg-white"
              placeholder="E17 Kortrijk"
            />
          </div>
          <div>
            <label className="block text-xs uppercase tracking-widest text-stone-500 mb-1">Locatie</label>
            <input
              required
              value={form.location}
              onChange={(e) => setForm({ ...form, location: e.target.value })}
              className="w-full border-2 border-black px-3 py-2 text-sm focus:outline-none bg-white"
              placeholder="Kortrijk"
            />
          </div>
          <div>
            <label className="block text-xs uppercase tracking-widest text-stone-500 mb-1">Stream-URL</label>
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
              {createCamera.isPending ? 'Opslaan…' : 'Opslaan'}
            </button>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="text-xs uppercase tracking-widest text-stone-400 px-4 py-2 hover:text-black"
            >
              Annuleren
            </button>
          </div>
        </form>
      )}

      <div className="border-2 border-black">
        {!cameras?.length && (
          <div className="px-4 py-6 text-xs text-stone-400 uppercase tracking-widest text-center">
            Geen camera's geconfigureerd
          </div>
        )}
        {cameras?.map((cam, i) => (
          <div
            key={cam.id}
            className={`px-4 py-3 ${i > 0 ? 'border-t-2 border-black' : ''}`}
          >
            {editingId === cam.id ? (
              <div className="bg-stone-50 -mx-4 -my-3 px-4 py-3">
                <p className="text-xs font-bold uppercase tracking-widest mb-3">Camera bewerken</p>
                <div className="flex items-start gap-4">
                  <CameraThumbnail cameraId={cam.id} className="w-28 aspect-[4/3] border-2 border-black shrink-0" />
                  <div className="flex-1 min-w-0 grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs uppercase tracking-widest text-stone-500 mb-1">Naam</label>
                      <input
                        autoFocus
                        value={editForm.name}
                        onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                        className="w-full border-2 border-black px-3 py-2 text-sm focus:outline-none bg-white"
                        placeholder="E17 Kortrijk"
                      />
                    </div>
                    <div>
                      <label className="block text-xs uppercase tracking-widest text-stone-500 mb-1">Locatie</label>
                      <input
                        value={editForm.location}
                        onChange={(e) => setEditForm({ ...editForm, location: e.target.value })}
                        className="w-full border-2 border-black px-3 py-2 text-sm focus:outline-none bg-white"
                        placeholder="Kortrijk"
                      />
                    </div>
                  </div>
                </div>
                <div className="flex gap-3 mt-4">
                  <button
                    onClick={() => saveEdit(cam.id)}
                    disabled={updateCamera.isPending}
                    className="text-xs uppercase tracking-widest border-2 border-black px-4 py-2 font-bold bg-black text-white hover:bg-stone-800 disabled:opacity-40 transition-colors"
                  >
                    {updateCamera.isPending ? 'Opslaan…' : 'Opslaan'}
                  </button>
                  <button
                    onClick={cancelEdit}
                    className="text-xs uppercase tracking-widest border border-stone-300 px-4 py-2 hover:border-black transition-colors"
                  >
                    Annuleren
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex justify-between items-center gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <CameraThumbnail cameraId={cam.id} className="w-24 aspect-[4/3] border border-black shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-bold uppercase truncate">{cam.name}</p>
                    <p className="text-xs text-stone-500 truncate">{cam.location}</p>
                    {cam.maxSpeedKmh && (
                      <p className="text-xs text-stone-400 mt-0.5">MAX {cam.maxSpeedKmh} KM/H</p>
                    )}
                    {cam.displaySlot && (
                      <p className="text-[10px] text-stone-400 mt-0.5 font-mono">{cam.displaySlot}</p>
                    )}
                  </div>
                </div>
                <div className="flex gap-2 shrink-0">
                  <button
                    onClick={() => startEdit(cam)}
                    className="text-xs uppercase tracking-widest border border-black px-2 py-1 hover:bg-black hover:text-white transition-colors"
                  >
                    Bewerken
                  </button>
                  <a
                    href={`/camera/${cam.id}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs uppercase tracking-widest border border-black px-2 py-1 hover:bg-black hover:text-white transition-colors"
                  >
                    Live ↗
                  </a>
                  <Link
                    to={`/cameras/${cam.id}/calibrate`}
                    className="text-xs uppercase tracking-widest border border-black px-2 py-1 hover:bg-black hover:text-white transition-colors"
                  >
                    Kalibreren
                  </Link>
                  <button
                    onClick={() => duplicateCamera.mutate(cam.id)}
                    disabled={duplicateCamera.isPending}
                    title="Kopieer de config van deze camera (geen Pi-slot, geen flits) om te A/B-testen"
                    className="text-xs uppercase tracking-widest border border-black px-2 py-1 hover:bg-black hover:text-white disabled:opacity-40 transition-colors"
                  >
                    {duplicateCamera.isPending ? '…' : 'Dupliceren'}
                  </button>
                  <button
                    onClick={() => deleteCamera.mutate(cam.id)}
                    disabled={deleteCamera.isPending}
                    className="text-xs uppercase tracking-widest border border-red-600 text-red-600 px-2 py-1 hover:bg-red-600 hover:text-white disabled:opacity-40 transition-colors"
                  >
                    Verwijderen
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
