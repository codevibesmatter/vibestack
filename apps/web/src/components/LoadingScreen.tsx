import React from 'react'

interface LoadingScreenProps {
  message?: string
}

export function LoadingScreen({ message = 'Loading...' }: LoadingScreenProps) {
  return (
    <div className="min-h-screen bg-[#1a1a1a] flex items-center justify-center">
      <div className="text-center">
        <div className="w-16 h-16 border-4 border-t-blue-500 border-opacity-25 rounded-full animate-spin mx-auto mb-4"></div>
        <div className="text-lg text-gray-300">{message}</div>
      </div>
    </div>
  )
} 