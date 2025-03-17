import React, { useState, useEffect } from 'react'
import { Link } from '@tanstack/react-router'
import { getDatabase } from '../db/core'

export function Welcome() {
  const [isGeneratingUsers, setIsGeneratingUsers] = useState(false)
  const [error, setError] = useState<string | null>(null)
  
  // Function to generate random users
  const generateRandomUsers = async (count: number = 100) => {
    setIsGeneratingUsers(true)
    setError(null)
    
    try {
      const db = await getDatabase()
      
      // Create a batch of random users
      const users = Array.from({ length: count }, (_, i) => {
        const id = crypto.randomUUID()
        const now = new Date().toISOString()
        return {
          id,
          name: `Random User ${i + 1}`,
          email: `user${i + 1}_${Math.floor(Math.random() * 10000)}@example.com`,
          createdAt: now,
          updatedAt: now
        }
      })
      
      // Insert users directly into the database
      for (const user of users) {
        await db.query(
          'INSERT INTO "user" (id, name, email, "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, $5)',
          [user.id, user.name, user.email, user.createdAt, user.updatedAt]
        )
      }
      
      alert(`Successfully added ${count} random users to the database!`)
    } catch (err) {
      console.error('Error generating random users:', err)
      setError(err instanceof Error ? err.message : 'Unknown error generating users')
    } finally {
      setIsGeneratingUsers(false)
    }
  }

  // Function to clear all users
  const clearAllUsers = async () => {
    if (!confirm("Are you sure you want to delete ALL users from the database? This action cannot be undone.")) {
      return;
    }
    
    setError(null);
    
    try {
      const db = await getDatabase();
      
      // Delete all users from the database
      await db.query('DELETE FROM "user"');
      
      alert("Successfully deleted all users from the database!");
    } catch (err) {
      console.error('Error clearing users:', err);
      setError(err instanceof Error ? err.message : 'Unknown error clearing users');
    }
  }

  return (
    <div className="text-center">
      <h1 className="text-4xl font-bold text-white mb-6">Welcome to VibeStack</h1>
      <p className="text-gray-300 mb-8">
        A modern task management system with real-time collaboration
      </p>
      <div className="space-x-4 mb-8">
        <Link 
          to="/admin"
          className="px-4 py-2 bg-[#404040] text-white rounded-md hover:bg-[#505050]"
        >
          Admin Panel
        </Link>
        <Link 
          to="/platform-test"
          className="px-4 py-2 bg-[#404040] text-white rounded-md hover:bg-[#505050]"
        >
          Platform Test
        </Link>
      </div>

      {/* Add Random Users Button */}
      <div className="mt-8 p-4 bg-[#2a2a2a] rounded-lg max-w-md mx-auto mb-6">
        <h2 className="text-xl font-semibold text-white mb-2">Database Actions</h2>
        <div className="flex flex-col space-y-2">
          <button
            onClick={() => generateRandomUsers(100)}
            disabled={isGeneratingUsers}
            className="px-4 py-2 bg-purple-600 text-white rounded-md hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isGeneratingUsers ? "Generating..." : "Generate 100 Random Users"}
          </button>
          <button
            onClick={clearAllUsers}
            className="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700"
          >
            Clear All Users
          </button>
        </div>
      </div>

      {/* Error Display */}
      {error && (
        <div className="mt-4 p-3 bg-red-900/50 text-red-200 rounded-md max-w-md mx-auto">
          <p className="text-sm">{error}</p>
        </div>
      )}
    </div>
  )
} 