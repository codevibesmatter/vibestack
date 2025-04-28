import React from 'react';
import { motion } from 'framer-motion';
import { SyncVisualizationCore } from './SyncVisualizationCore';

export function MiniSyncVisualizer() {
  // Optional: Conditionally render based on environment or feature flag
  // if (process.env.NODE_ENV !== 'development') {
  //   return null;
  // }

  return (
    <motion.div
      // --- Modern floating card style ---
      className="fixed bottom-24 right-4 z-[1000] w-72 bg-card/95 backdrop-blur-sm rounded-lg shadow-lg overflow-visible"
      // --- Smooth entrance animation ---
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.5, ease: [0.23, 1, 0.32, 1] }}
      // --- Subtle hover effect ---
      whileHover={{ 
        boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.2), 0 8px 10px -6px rgba(0, 0, 0, 0.1)",
        y: -2
      }}
    >
      {/* Enhanced visualizer without header */}
      <div className="p-3">
        <SyncVisualizationCore className="h-auto w-full" />
      </div>
    </motion.div>
  );
} 