interface Props {
  cameraId: string
  className?: string
}

export function MJPEGStream({ cameraId, className }: Props) {
  return (
    <div className={`relative overflow-hidden bg-black ${className ?? ''}`}>
      <img
        src={`/api/cameras/${cameraId}/mjpeg`}
        className="w-full h-full object-contain"
        alt=""
      />
    </div>
  )
}
