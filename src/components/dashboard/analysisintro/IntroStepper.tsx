'use client'

import { useState, useEffect } from 'react'
import { useGmailPermissions } from '@/context/GmailPermissionsProvider'
import Step1_ConnectGmail from './Step1_ConnectGmail'
import Step2_RunAnalysis from './Step2_RunAnalysis'
import { cn } from '@/lib/utils'
import { motion, AnimatePresence } from 'framer-motion'
import { ArrowLeft } from 'lucide-react'
import { useAnalysisOperations } from '@/hooks/useAnalysisOperation'

interface IntroStepperProps {
  onComplete: () => void;
  onCancel?: () => void;
  isReanalysis?: boolean;
}

export default function IntroStepper({ 
  onComplete, 
  onCancel, 
  isReanalysis = false 
}: IntroStepperProps) {
  const [currentStep, setCurrentStep] = useState(1)
  const [animationDirection, setAnimationDirection] = useState(0) // 0 for initial, 1 for forward
  const { tokenStatus, hasRefreshToken } = useGmailPermissions()
  const { startAnalysis } = useAnalysisOperations()
  
  // Always start at step 1 if we don't have a valid refresh token.
  // If a refresh token exists, user is considered connected and should start at step 2.
  useEffect(() => {
    if (hasRefreshToken) {
      setCurrentStep(2)
      setAnimationDirection(1)
    } else {
      setCurrentStep(1)
    }
  }, [hasRefreshToken])

  const goToNextStep = () => {
    setAnimationDirection(1)
    setCurrentStep(2)
  }

  const handleStepComplete = async (step: number) => {
    if (step === 1) {
      setCurrentStep(2);
    } else if (step === 2) {
      onComplete();
    }
  }

  const totalSteps = 2
  
  return (
    <div className="flex flex-col w-full h-full bg-white dark:bg-slate-800 rounded-lg overflow-hidden">
      {/* Refined header with step indicator */}
      <div className="h-10 lg:h-12 xl:h-16 flex items-center justify-center border-b border-gray-100 dark:border-slate-700 relative">
        {onCancel && (
          <button 
            onClick={onCancel}
            className="absolute left-2 lg:left-4 flex items-center text-slate-500 dark:text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors py-2"
            aria-label={isReanalysis ? "Back to sender analysis" : "Back"}
          >
            <ArrowLeft size={12} className="lg:w-3 lg:h-3 xl:w-4 xl:h-4 mr-1 lg:mr-1.5" />
            <span className="text-xs font-medium hidden sm:inline">
              {isReanalysis ? "Back to sender analysis" : "Back"}
            </span>
          </button>
        )}
        
        {/* Step indicator */}
        <div className="flex items-center space-x-0">
          {Array.from({ length: totalSteps }).map((_, i) => (
            <div key={i} className="flex items-center">
              {i > 0 && (
                <div className="h-0.5 w-4 lg:w-6 xl:w-12 bg-gray-200 dark:bg-slate-600 relative overflow-hidden mx-0.5 lg:mx-1 xl:mx-2">
                  <div className={cn(
                    "h-full absolute inset-0 transition-all duration-500 ease-in-out",
                    currentStep > i ? "w-full bg-blue-600 dark:bg-blue-500" : "w-0 bg-blue-600 dark:bg-blue-500"
                  )} />
                </div>
              )}
              <div 
                className={cn(
                  "w-3 h-3 lg:w-4 lg:h-4 xl:w-6 xl:h-6 rounded-full flex items-center justify-center text-xs font-medium transition-all",
                  currentStep > i 
                    ? "bg-blue-600 dark:bg-blue-500 text-white dark:text-slate-100" 
                    : currentStep === i + 1
                      ? "bg-blue-600 dark:bg-blue-500 text-white dark:text-slate-100 ring-1 lg:ring-2 xl:ring-4 ring-blue-100 dark:ring-blue-500/20" 
                      : "bg-gray-200 dark:bg-slate-700 text-gray-500 dark:text-slate-400"
                )}
              >
                <span className="text-xs lg:text-xs xl:text-sm">{i + 1}</span>
              </div>
            </div>
          ))}
        </div>
        
        <div className="absolute right-2 lg:right-4 text-xs font-medium text-gray-500 dark:text-slate-400">
          Step {currentStep} of {totalSteps}
        </div>
      </div>

      {/* Content area with refined animation */}
      <div className="flex-1 overflow-hidden">
        <AnimatePresence mode="wait">
          <motion.div
            key={currentStep}
            initial={{ 
              opacity: 0,
              x: animationDirection === 1 ? 20 : -20
            }}
            animate={{ 
              opacity: 1,
              x: 0
            }}
            exit={{ 
              opacity: 0,
              x: animationDirection === 1 ? -20 : 20
            }}
            transition={{ 
              duration: 0.3, 
              ease: "easeInOut" 
            }}
            className="h-full w-full"
          >
            {currentStep === 1 && (
              <Step1_ConnectGmail onNext={goToNextStep} />
            )}
            
            {currentStep === 2 && (
              <Step2_RunAnalysis onStart={handleStepComplete} />
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  )
}