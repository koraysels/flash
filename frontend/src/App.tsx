import { BrowserRouter, Routes, Route, NavLink, Outlet } from 'react-router-dom'
import Dashboard from './pages/Dashboard'
import Cameras from './pages/Cameras'
import CameraCalibrate from './pages/CameraCalibrate'
import PiDisplay from './pages/PiDisplay'

function Layout() {
  return (
    <div className="min-h-screen bg-white text-black">
      <nav className="border-b-2 border-black px-6 py-3 flex items-center gap-8">
        <span className="font-bold text-sm tracking-widest uppercase">FLASH</span>
        <NavLink
          to="/"
          end
          className={({ isActive }) =>
            isActive
              ? 'text-xs tracking-widest uppercase bg-black text-white px-2 py-1'
              : 'text-xs tracking-widest uppercase text-stone-400 hover:text-black px-2 py-1'
          }
        >
          Dashboard
        </NavLink>
        <NavLink
          to="/cameras"
          className={({ isActive }) =>
            isActive
              ? 'text-xs tracking-widest uppercase bg-black text-white px-2 py-1'
              : 'text-xs tracking-widest uppercase text-stone-400 hover:text-black px-2 py-1'
          }
        >
          Cameras
        </NavLink>
      </nav>
      <main className="p-6">
        <Outlet />
      </main>
    </div>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/cameras" element={<Cameras />} />
          <Route path="/cameras/:id/calibrate" element={<CameraCalibrate />} />
        </Route>
        <Route path="/display/:cameraId" element={<PiDisplay />} />
      </Routes>
    </BrowserRouter>
  )
}
