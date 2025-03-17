import React from 'react'
import { Link } from '@tanstack/react-router'

const links = [
  { to: '/platform-test', label: 'Platform Test' },
  { to: '/admin', label: 'Admin' }
]

export function NavBar() {
  return (
    <nav className="bg-[#242424] shadow-lg">
      <div className="container mx-auto px-4">
        <div className="flex items-center justify-between h-16">
          <div className="flex items-center">
            <Link to="/" className="text-white font-bold text-xl">
              VibeStack
            </Link>
          </div>
          <div className="flex space-x-4">
            {links.map(({ to, label }) => (
              <Link
                key={to}
                to={to}
                activeProps={{ className: 'bg-[#404040] text-white' }}
                inactiveProps={{ className: 'text-gray-300 hover:bg-[#404040] hover:text-white' }}
                className="px-3 py-2 rounded-md text-sm font-medium"
              >
                {label}
              </Link>
            ))}
          </div>
        </div>
      </div>
    </nav>
  )
} 