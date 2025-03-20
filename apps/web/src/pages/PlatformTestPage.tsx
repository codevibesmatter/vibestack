import React, { useState, useEffect, useRef } from 'react';
import { User } from '@repo/dataforge/client-entities';
import { ensureDB } from '../db/types';
import { getDatabase } from '../db/core';
import { PlatformUsersTable, PlatformUsersTableRef, UserRow } from '../components/PlatformUsersTable';
import { useAtom } from 'jotai';
import { dbMessageBus } from '../db/message-bus';
import { DbEventType } from '../db/message-bus';
// Import from our new Jotai store
import {
  usersAtom,
  usersLoadingAtom,
  usersErrorAtom,
  usersTotalCountAtom,
  usersMetricsAtom,
  selectedUserIdAtom,
  highlightedUserIdAtom,
  fetchUsersAtom,
  createUserAtom,
  updateUserAtom,
  deleteUserAtom,
  userDbSubscriptionAtom,
  usersByIdAtom
} from '../data/user/store';
// Import from the new data layer for performance testing
import { QueryBuilder } from '../data/common/base/QueryBuilder';
// Import PerformanceMetrics type
import { PerformanceMetrics } from '../data/common/base/DataAccess';
// Import the direct API functions
import { updateUser as updateUserApi } from '../data/user/api';

// Define a simplified User type for our optimistic updates
interface SimpleUser {
  id: string;
  name: string;
  email: string;
  createdAt: Date;
  updatedAt: Date;
}

export default function PlatformTestPage() {
  // Jotai state
  const [users] = useAtom(usersAtom);
  const [loading] = useAtom(usersLoadingAtom);
  const [error] = useAtom(usersErrorAtom);
  const [totalUsers] = useAtom(usersTotalCountAtom);
  const [metrics] = useAtom(usersMetricsAtom);
  const [selectedUserId, setSelectedUserId] = useAtom(selectedUserIdAtom);
  const [highlightedUserId, setHighlightedUserId] = useAtom(highlightedUserIdAtom);
  const [, fetchUsers] = useAtom(fetchUsersAtom);
  const [, createUser] = useAtom(createUserAtom);
  const [, updateUser] = useAtom(updateUserAtom);
  const [, deleteUser] = useAtom(deleteUserAtom);

  // Local state
  const [isAddingUser, setIsAddingUser] = useState(false);
  const [newUserName, setNewUserName] = useState('');
  const [newUserEmail, setNewUserEmail] = useState('');
  const [activeTab, setActiveTab] = useState('users');
  const [isTableVisible, setIsTableVisible] = useState(true);
  
  // Refs
  const tableRef = useRef<PlatformUsersTableRef>(null);
  const processingFailureCount = useRef(0);

  // Database subscription state
  const [isSubscribed, setIsSubscribed] = useState(true);
  const [, subscribeToDb] = useAtom(userDbSubscriptionAtom);
  const [usersById] = useAtom(usersByIdAtom);
  
  // Toggle database subscription
  const toggleSubscription = () => {
    const newState = !isSubscribed;
    setIsSubscribed(newState);
    
    if (newState) {
      // Subscribe to database changes
      subscribeToDb(true);
      console.log('Subscribed to database changes for users');
    } else {
      // Unsubscribe from database changes
      subscribeToDb(false);
      console.log('Unsubscribed from database changes for users');
    }
  };
  
  // Fetch users on mount
  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  // Handle processing failures
  useEffect(() => {
    if (error) {
      processingFailureCount.current += 1;
      console.error(`Processing failure #${processingFailureCount.current}:`, error);
      
      // If we've had multiple failures, try to recover by fetching fresh data
      if (processingFailureCount.current > 2) {
        console.log('Multiple failures detected, attempting recovery...');
        fetchUsers();
        processingFailureCount.current = 0;
      }
    } else {
      // Reset counter when successful
      processingFailureCount.current = 0;
    }
  }, [error, fetchUsers]);

  // Handle user editing - now just processes the edit without highlighting
  const handleEditUser = (user: UserRow) => {
    setSelectedUserId(user.id);
  };

  // Handle adding new user
  const handleAddUser = async () => {
    try {
      // Create a new user with the form data
      const newUserId = await createUser({
        name: newUserName,
        email: newUserEmail
      });
      
      if (newUserId) {
        console.log(`Created user with ID: ${newUserId}`);
        
        // Reset form
        setIsAddingUser(false);
        setNewUserName('');
        setNewUserEmail('');
        
        // Fetch the updated list of users
        fetchUsers();
      }
    } catch (error) {
      console.error('Error creating user:', error);
    }
  };

  // Handle deleting a user
  const handleDeleteUser = async (user: UserRow) => {
    try {
      // Confirm deletion
      if (!window.confirm(`Are you sure you want to delete ${user.name}?`)) {
        return;
      }
      
      // Delete the user
      await deleteUser(user.id);
      console.log(`Deleted user with ID: ${user.id}`);
      
      // Reset table pagination
      if (tableRef.current) {
        tableRef.current.resetPagination();
      }
    } catch (err) {
      console.error('Error deleting user:', err);
    }
  };

  // Function to update a random visible user
  const handleUpdateVisibleUser = async () => {
    if (!tableRef.current) return;
    
    // Get currently visible users from the table
    const visibleUsers = tableRef.current.getVisibleUsers();
    
    if (visibleUsers.length === 0) {
      console.log('No visible users to update');
      return;
    }
    
    // Select a random user from the visible ones
    const randomIndex = Math.floor(Math.random() * visibleUsers.length);
    const randomUser = visibleUsers[randomIndex];
    
    try {
      // Create a small update - append a timestamp to the name
      const timestamp = new Date().toLocaleTimeString();
      const updatedName = `${randomUser.name.split(' [')[0]} [${timestamp}]`;
      
      console.log(`Updating user ${randomUser.id} with new name: ${updatedName}`);
      
      // Use the direct API function instead of the Jotai atom
      // This will record a change that will be processed by the change processor
      await updateUserApi(randomUser.id, { name: updatedName });
      
      // No need for highlighting or forced refresh - the change processor will update the atoms
      // which will trigger a re-render of the table
      
      console.log(`Updated user: ${randomUser.name} -> ${updatedName}`);
    } catch (err) {
      console.error('Error updating random user:', err);
    }
  };

  // Render the page
  return (
    <div className="min-h-screen bg-[#121212] text-white">
      <div className="container mx-auto px-4 py-8">
        <h1 className="text-4xl font-bold mb-8 text-center">Platform Test Page</h1>
        
        {/* Database Subscription Status */}
        <div className="mb-6 p-4 rounded-lg shadow border border-[#404040] bg-[#242424]">
          <h3 className="text-lg font-medium text-white mb-2">
            Database Subscription: 
            <span className={`ml-2 px-2 py-1 rounded text-sm ${isSubscribed ? 'bg-green-600' : 'bg-red-600'}`}>
              {isSubscribed ? 'ACTIVE' : 'INACTIVE'}
            </span>
          </h3>
          <button
            onClick={toggleSubscription}
            className={`px-4 py-2 rounded text-white ${
              isSubscribed ? 'bg-red-600 hover:bg-red-700' : 'bg-green-600 hover:bg-green-700'
            }`}
          >
            {isSubscribed ? 'Unsubscribe' : 'Subscribe to DB Changes'}
          </button>
          <p className="mt-2 text-sm text-gray-400">
            Users in normalized store: {Object.keys(usersById).length}
          </p>
          <p className="mt-1 text-xs text-gray-500">
            {isSubscribed 
              ? 'When subscription is active, UI will automatically update when users change in the database.' 
              : 'When subscription is inactive, you need to manually refresh to see database changes.'}
          </p>
        </div>
        
        {/* Tabs */}
        <div className="mb-6">
          <div className="border-b border-[#404040]">
            <nav className="-mb-px flex space-x-8">
              <button
                onClick={() => setActiveTab('users')}
                className={`py-4 px-1 border-b-2 font-medium text-sm ${
                  activeTab === 'users'
                    ? 'border-purple-500 text-purple-400'
                    : 'border-transparent text-gray-400 hover:text-gray-300 hover:border-gray-300'
                }`}
              >
                Users
              </button>
              <button
                onClick={() => setActiveTab('performance')}
                className={`py-4 px-1 border-b-2 font-medium text-sm ${
                  activeTab === 'performance'
                    ? 'border-purple-500 text-purple-400'
                    : 'border-transparent text-gray-400 hover:text-gray-300 hover:border-gray-300'
                }`}
              >
                Performance
              </button>
            </nav>
          </div>
        </div>
        
        {/* Users Tab */}
        {activeTab === 'users' && (
          <div className="border border-[#404040] rounded-lg p-6 mb-6 bg-[#242424]">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-semibold text-white">Users</h2>
              <div className="flex space-x-4">
                <button
                  onClick={() => setIsAddingUser(true)}
                  className="px-4 py-2 bg-purple-600 text-white rounded hover:bg-purple-700 transition-colors"
                >
                  Add User
                </button>
                <button
                  onClick={() => {
                    setIsTableVisible(!isTableVisible);
                  }}
                  className="px-4 py-2 bg-[#404040] text-white rounded hover:bg-[#505050] transition-colors"
                >
                  {isTableVisible ? 'Hide Table' : 'Show Table'}
                </button>
              </div>
            </div>
            
            {/* Add User Form */}
            {isAddingUser && (
              <div className="border border-[#404040] p-4 rounded-lg shadow mb-6 bg-[#1a1a1a]">
                <h3 className="text-lg font-medium text-white mb-4">Add New User</h3>
                <div className="space-y-4">
                  <div>
                    <label htmlFor="name" className="block text-sm font-medium text-gray-300">
                      Name
                    </label>
                    <input
                      type="text"
                      id="name"
                      value={newUserName}
                      onChange={(e) => setNewUserName(e.target.value)}
                      className="mt-1 block w-full bg-[#2a2a2a] border border-[#404040] rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-purple-500 focus:border-purple-500 sm:text-sm text-white"
                    />
                  </div>
                  <div>
                    <label htmlFor="email" className="block text-sm font-medium text-gray-300">
                      Email
                    </label>
                    <input
                      type="email"
                      id="email"
                      value={newUserEmail}
                      onChange={(e) => setNewUserEmail(e.target.value)}
                      className="mt-1 block w-full bg-[#2a2a2a] border border-[#404040] rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-purple-500 focus:border-purple-500 sm:text-sm text-white"
                    />
                  </div>
                  <div className="flex justify-end space-x-2">
                    <button
                      onClick={() => {
                        setIsAddingUser(false);
                        setNewUserName('');
                        setNewUserEmail('');
                      }}
                      className="px-4 py-2 bg-[#404040] text-white rounded hover:bg-[#505050] transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleAddUser}
                      disabled={!newUserName || !newUserEmail}
                      className={`px-4 py-2 rounded text-white ${
                        !newUserName || !newUserEmail
                          ? 'bg-gray-500 cursor-not-allowed'
                          : 'bg-purple-600 hover:bg-purple-700'
                      }`}
                    >
                      Save
                    </button>
                  </div>
                </div>
              </div>
            )}
            
            {/* Users Table */}
            <PlatformUsersTable
              ref={tableRef}
              onEdit={handleEditUser}
              onDelete={handleDeleteUser}
              isVisible={isTableVisible}
            />
          </div>
        )}
        
        {/* Performance Tab */}
        {activeTab === 'performance' && (
          <div className="border border-[#404040] rounded-lg p-6 mb-6 bg-[#242424]">
            <h2 className="text-xl font-semibold mb-6 text-white">Performance Testing</h2>
            <div className="border border-[#404040] p-6 rounded-lg shadow bg-[#1a1a1a]">
              <h3 className="text-lg font-medium text-white mb-4">Query Performance</h3>
              
              <div className="space-y-6">
                <div>
                  <h4 className="text-sm font-medium text-gray-300 mb-2">Query Builder Performance</h4>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="p-3 bg-[#2a2a2a] rounded border border-[#404040]">
                      <span className="text-gray-400">Query Time:</span>
                      <span className="ml-2 text-green-400">
                        {metrics.queryTime > 0 ? `${metrics.queryTime.toFixed(2)}ms` : 'N/A'}
                      </span>
                    </div>
                    <div className="p-3 bg-[#2a2a2a] rounded border border-[#404040]">
                      <span className="text-gray-400">Total Time:</span>
                      <span className="ml-2 text-purple-400">
                        {metrics.totalTime > 0 ? `${metrics.totalTime.toFixed(2)}ms` : 'N/A'}
                      </span>
                      <p className="text-xs text-gray-400 mt-1">Total time including data processing</p>
                    </div>
                  </div>
                </div>
                
                <div className="mt-6">
                  <h4 className="text-sm font-medium text-gray-300 mb-2">Data Statistics</h4>
                  <p className="text-gray-300 p-3 bg-[#2a2a2a] rounded border border-[#404040]">
                    Total Users: <span className="font-semibold text-white">{totalUsers}</span>
                  </p>
                </div>
                
                <div className="mt-6 flex justify-end">
                  <button
                    onClick={() => fetchUsers()}
                    className="px-4 py-2 bg-purple-600 text-white rounded hover:bg-purple-700 transition-colors"
                  >
                    Run Performance Test
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
        
        {/* Floating Action Buttons */}
        <div className="fixed bottom-8 right-8 flex space-x-4">
          <button
            onClick={() => {
              // Debug function to log the current state of users
              console.log('Current users array:', users);
              console.log('Current usersById:', usersById);
              console.log('Current sorting in table:', tableRef.current?.getCurrentSorting?.());
            }}
            className="px-4 py-2 bg-[#1a1a1a] text-white rounded-full shadow-lg hover:bg-[#2a2a2a] transition-colors flex items-center space-x-2 border border-[#404040]"
            title="Log current users state for debugging"
          >
            <span>Debug Users</span>
            <span className="text-lg">🔍</span>
          </button>
          
          <button
            onClick={handleUpdateVisibleUser}
            className="px-4 py-2 bg-purple-600 text-white rounded-full shadow-lg hover:bg-purple-700 transition-colors flex items-center space-x-2"
            title="Update a random visible user with a timestamp"
          >
            <span>Update Visible User</span>
            <span className="text-lg">↻</span>
          </button>
        </div>
      </div>
    </div>
  );
} 