import React from 'react';
import { motion } from 'framer-motion';
import { useSyncVisualizationState } from '../hooks/useSyncVisualizationState';

interface SyncVisualizationCoreProps {
  className?: string; // Allow className for the container
}

export function SyncVisualizationCore({ className }: SyncVisualizationCoreProps) {
  // Get state from the custom hook
  const { 
    currentConnectionState, 
    outgoingStatus, 
    incomingStatus 
  } = useSyncVisualizationState();

  // Enhanced connection line animations with more visual interest
  const connectionVariants = {
    disconnected: {
      stroke: '#a0aec0', // gray-500
      strokeDasharray: '5, 5',
      strokeDashoffset: [0, 20],
      opacity: 0.7,
      pathLength: 0.9,
      transition: {
        strokeDashoffset: { 
          repeat: Infinity, 
          duration: 5,
          ease: "linear" 
        }
      }
    },
    connecting: {
      stroke: '#f6ad55', // orange-400
      strokeDasharray: '10, 5',
      strokeDashoffset: [0, 30],
      opacity: [0.5, 0.9, 0.5], // Pulse effect
      pathLength: 1,
      transition: { 
        opacity: { duration: 1.2, repeat: Infinity, ease: 'easeInOut' },
        pathLength: { duration: 0.8, ease: 'easeOut' },
        strokeDashoffset: { 
          repeat: Infinity, 
          duration: 2.5,
          ease: "linear" 
        }
      }
    },
    initial: {
      stroke: '#4299e1', // blue-500
      strokeDasharray: '0',
      opacity: 0.9,
      pathLength: 1
    },
    catchup: {
      stroke: '#4299e1', // blue-500
      strokeWidth: [2, 3, 2],
      strokeDasharray: '0',
      opacity: [0.7, 1, 0.7], // Subtle pulse
      pathLength: 1,
      transition: { 
        opacity: { duration: 2, repeat: Infinity, ease: 'easeInOut' },
        strokeWidth: { duration: 2, repeat: Infinity, ease: 'easeInOut' }
      }
    },
    live: {
      stroke: '#48bb78', // green-500
      strokeDasharray: '0',
      opacity: 1,
      pathLength: 1,
      filter: "drop-shadow(0 0 3px rgba(72, 187, 120, 0.6))",
      transition: { duration: 0.4 }
    },
    error: {
      stroke: '#f56565', // red-500
      strokeDasharray: '0',
      opacity: [0.6, 1, 0.6], // Error pulse
      strokeWidth: [2, 3, 2],
      pathLength: 1,
      transition: { 
        opacity: { duration: 0.8, repeat: Infinity, ease: 'easeInOut' },
        strokeWidth: { duration: 0.8, repeat: Infinity, ease: 'easeInOut' }
      }
    },
  };

  // Orb variants - for client/server state animations
  const clientOrbVariants = {
    idle: {
      scale: 1,
      backgroundColor: '#3b82f6',
    },
    sending: {
      scale: [1, 1.15, 1],
      backgroundColor: '#4361ee',
      transition: { 
        duration: 1, 
        repeat: Infinity,
        repeatType: "loop" as const,
        ease: "easeInOut"
      }
    },
    acknowledged: {
      scale: [1, 1.2, 1],
      backgroundColor: '#3b82f6',
      transition: { 
        duration: 0.8, 
        ease: "easeOut",
        repeat: 1
      }
    },
    error: {
      scale: [1, 0.9, 1],
      backgroundColor: '#f56565',
      transition: { 
        duration: 0.5, 
        ease: "easeOut",
        repeat: 1
      }
    },
    timeout: {
      scale: [1, 0.9, 1],
      backgroundColor: '#dd6b20',
      transition: { 
        duration: 0.5, 
        ease: "easeOut",
        repeat: 1
      }
    }
  };

  const serverOrbVariants = {
    idle: {
      scale: 1,
      backgroundColor: '#10b981',
    },
    receiving: {
      scale: [1, 1.15, 1],
      backgroundColor: '#059669',
      transition: { 
        duration: 1, 
        repeat: Infinity,
        repeatType: "loop" as const,
        ease: "easeInOut"
      }
    },
    processed: {
      scale: [1, 1.2, 1],
      backgroundColor: '#10b981',
      transition: { 
        duration: 0.8, 
        ease: "easeOut",
        repeat: 1
      }
    },
    error: {
      scale: [1, 0.9, 1],
      backgroundColor: '#f56565',
      transition: { 
        duration: 0.5, 
        ease: "easeOut",
        repeat: 1
      }
    }
  };

  return (
    <div className={`relative w-full aspect-[3/1.2] rounded-lg overflow-hidden ${className ?? ''}`}>
      {/* Background gradient */}
      <motion.div 
        className="absolute inset-0 bg-gradient-to-br from-background/80 to-background"
        animate={{
          background: 
            currentConnectionState === 'error' ? 'linear-gradient(to bottom right, rgba(254, 242, 242, 0.05), rgba(20, 20, 30, 0.95))' :
            currentConnectionState === 'disconnected' ? 'linear-gradient(to bottom right, rgba(226, 232, 240, 0.05), rgba(20, 20, 30, 0.95))' :
            currentConnectionState === 'connecting' ? 'linear-gradient(to bottom right, rgba(255, 237, 213, 0.05), rgba(20, 20, 30, 0.95))' :
            currentConnectionState === 'live' ? 'linear-gradient(to bottom right, rgba(240, 255, 244, 0.05), rgba(20, 20, 30, 0.95))' :
            'linear-gradient(to bottom right, rgba(235, 244, 255, 0.05), rgba(20, 20, 30, 0.95))'
        }}
        transition={{ duration: 0.5 }}
      />

      {/* Client Orb */}
      <motion.div 
        className="absolute left-5 top-1/2 -translate-y-1/2 w-12 h-12 rounded-full flex items-center justify-center text-white text-xs font-bold shadow-md z-10"
        variants={clientOrbVariants}
        animate={outgoingStatus !== 'idle' ? outgoingStatus : 'idle'}
        initial="idle"
        style={{
          boxShadow: outgoingStatus === 'sending' 
            ? '0 0 12px rgba(59, 130, 246, 0.7)' 
            : '0 0 5px rgba(59, 130, 246, 0.4)'
        }}
      >
        CLIENT
      </motion.div>
      
      {/* Server Orb */}
      <motion.div 
        className="absolute right-5 top-1/2 -translate-y-1/2 w-12 h-12 rounded-full flex items-center justify-center text-white text-xs font-bold shadow-md z-10"
        variants={serverOrbVariants}
        animate={incomingStatus !== 'idle' ? incomingStatus : 'idle'}
        initial="idle"
        style={{
          boxShadow: incomingStatus === 'receiving' 
            ? '0 0 12px rgba(16, 185, 129, 0.7)' 
            : '0 0 5px rgba(16, 185, 129, 0.4)'
        }}
      >
        SERVER
      </motion.div>

      {/* Connection Line */}
      <svg 
        className="absolute top-0 left-0 w-full h-full" 
        viewBox="0 0 300 100" 
        preserveAspectRatio="xMidYMid meet"
      >
        {/* Optional glow filter for the line */}
        <defs>
          <filter id="glow" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="2" result="blur" />
            <feComposite in="SourceGraphic" in2="blur" operator="over" />
          </filter>
        </defs>

        {/* Connection line with enhanced animation */}
        <motion.line
          x1="60"
          y1="50"
          x2="240"
          y2="50"
          strokeWidth="2"
          variants={connectionVariants}
          animate={currentConnectionState}
          initial="disconnected"
          filter="url(#glow)"
        />

        {/* Connection status text */}
        <motion.text
          x="150"
          y="78"
          textAnchor="middle"
          fontSize="9"
          fontFamily="monospace"
          initial={{
            opacity: 0.9,
            fill: '#a0aec0'
          }}
          animate={{
            fill: currentConnectionState === 'live' ? '#48bb78' : 
                 currentConnectionState === 'error' ? '#f56565' :
                 currentConnectionState === 'connecting' ? '#f6ad55' :
                 currentConnectionState === 'disconnected' ? '#a0aec0' : '#4299e1',
            opacity: 0.9
          }}
        >
          {currentConnectionState}
        </motion.text>
      </svg>
    </div>
  );
} 