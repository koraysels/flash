import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom'
import Dashboard from './pages/Dashboard'
import Cameras from './pages/Cameras'
import CameraCalibrate from './pages/CameraCalibrate'
import PiDisplay from './pages/PiDisplay'

export default function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen bg-gray-950 text-gray-100">
        <nav className="border-b border-gray-800 px-6 py-3 flex gap-6 items-center">
          <span className="font-bold text-lg tracking-tight">Flash</span>
          <NavLink
            to="/"
            end
            className={({ isActive }) => isActive ? 'text-blue-400' : 'text-gray-400 hover:text-white'}
          >
            Dashboard
          </NavLink>
          <NavLink
            to="/cameras"
            className={({ isActive }) => isActive ? 'text-blue-400' : 'text-gray-400 hover:text-white'}
          >
            Cameras
          </NavLink>
        </nav>
        <main className="p-6">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/cameras" element={<Cameras />} />
            <Route path="/cameras/:id/calibrate" element={<CameraCalibrate />} />
            <Route path="/display/:cameraId" element={<PiDisplay />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  )
}
