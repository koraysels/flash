import { BrowserRouter, Routes, Route, NavLink, Outlet } from 'react-router-dom'
import Dashboard from './pages/Dashboard'
import Cameras from './pages/Cameras'
import History from './pages/History'
import CameraCalibrate from './pages/CameraCalibrate'
import PiDisplay from './pages/PiDisplay'
import CameraDisplay from './pages/CameraDisplay'
import PinGate from './components/PinGate'

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
          Overzicht
        </NavLink>
        <NavLink
          to="/cameras"
          className={({ isActive }) =>
            isActive
              ? 'text-xs tracking-widest uppercase bg-black text-white px-2 py-1'
              : 'text-xs tracking-widest uppercase text-stone-400 hover:text-black px-2 py-1'
          }
        >
          Camera's
        </NavLink>
        <NavLink
          to="/history"
          className={({ isActive }) =>
            isActive
              ? 'text-xs tracking-widest uppercase bg-black text-white px-2 py-1'
              : 'text-xs tracking-widest uppercase text-stone-400 hover:text-black px-2 py-1'
          }
        >
          Historiek
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
        <Route element={<PinGate><Layout /></PinGate>}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/cameras" element={<Cameras />} />
          <Route path="/history" element={<History />} />
          <Route path="/cameras/:id/calibrate" element={<CameraCalibrate />} />
        </Route>
        <Route path="/camera/:cameraId" element={<CameraDisplay />} />
        <Route path="/display/:slug" element={<PiDisplay />} />
      </Routes>
    </BrowserRouter>
  )
}
