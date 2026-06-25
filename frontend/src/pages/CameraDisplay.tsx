import { useParams } from 'react-router-dom'
import { AnnotatedFullscreen } from '../components/AnnotatedFullscreen'

/** Direct fullscreen view of one camera: /camera/:cameraId */
export default function CameraDisplay() {
  const { cameraId } = useParams<{ cameraId: string }>()
  return (
    <div className="fixed inset-0 bg-black">
      <AnnotatedFullscreen cameraId={cameraId ?? null} />
    </div>
  )
}
