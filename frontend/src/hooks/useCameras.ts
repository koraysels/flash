import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getCameras, createCamera, updateCamera, deleteCamera, Camera } from '../lib/api'

export function useCameras() {
  return useQuery({
    queryKey: ['cameras'],
    queryFn: getCameras,
    staleTime: 10_000,
    refetchInterval: 30_000,
  })
}

export function useCreateCamera() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: createCamera,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cameras'] }),
  })
}

export function useUpdateCamera() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<Camera> }) => updateCamera(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cameras'] }),
  })
}

export function useDeleteCamera() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: deleteCamera,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cameras'] }),
  })
}
