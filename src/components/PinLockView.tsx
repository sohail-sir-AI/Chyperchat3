import React, { useState, useEffect } from 'react';
import { ShieldCheck, Lock, Unlock, Delete, RefreshCw, Eye, EyeOff } from 'lucide-react';

interface PinLockViewProps {
  savedPin: string | null;
  onSuccess: (pin: string) => void;
  onSetPin: (pin: string) => void;
  onResetPin?: () => void;
  isEmergencyUnlocked?: boolean;
}

export default function PinLockView({ savedPin, onSuccess, onSetPin, onResetPin }: PinLockViewProps) {
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [isConfirming, setIsConfirming] = useState(false);
  const [error, setError] = useState('');
  const [shake, setShake] = useState(false);
  const [showMask, setShowMask] = useState(true);

  // Clear pin on error shake finish
  useEffect(() => {
    if (shake) {
      const timer = setTimeout(() => {
        setShake(false);
        setPin('');
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [shake]);

  const handleNumberClick = (num: string) => {
    if (shake) return;
    setError('');
    
    // Support max 6-digit PINs, let's lock at 4 digits for classic clean numberpad experience
    if (pin.length < 4) {
      const newPin = pin + num;
      setPin(newPin);
      
      // Auto-validate once 4 digits are completed
      if (newPin.length === 4) {
        if (savedPin) {
          // ENTER MODE
          if (newPin === savedPin) {
            onSuccess(newPin);
          } else {
            setError('Incorrect Security PIN. Access Denied.');
            setShake(true);
          }
        } else {
          // SET MODE
          if (!isConfirming) {
            // First leg of setting PIN
            setConfirmPin(newPin);
            setIsConfirming(true);
            setPin('');
          } else {
            // Confirming leg
            if (newPin === confirmPin) {
              onSetPin(newPin);
            } else {
              setError('PINs do not match. Restarting...');
              setShake(true);
              setIsConfirming(false);
              setConfirmPin('');
            }
          }
        }
      }
    }
  };

  const handleBackspace = () => {
    if (shake) return;
    setPin(pin.slice(0, -1));
  };

  const handleClear = () => {
    setPin('');
    if (savedPin) {
      if (onResetPin) {
        onResetPin();
      }
    } else {
      setIsConfirming(false);
      setConfirmPin('');
    }
    setError('');
  };

  // Keyboard navigation support
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key >= '0' && e.key <= '9') {
        handleNumberClick(e.key);
      } else if (e.key === 'Backspace') {
        handleBackspace();
      } else if (e.key === 'Escape') {
        handleClear();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [pin, confirmPin, isConfirming, savedPin, shake]);

  return (
    <div className="fixed inset-0 bg-slate-950 flex flex-col items-center justify-center p-4 z-[9999] overflow-y-auto selection:bg-slate-900 animate-fadeIn">
      {/* Visual Header */}
      <div className="w-full max-w-sm text-center mb-8">
        <div className="inline-flex p-4 rounded-3xl bg-slate-900 border border-slate-800/80 text-amber-500 mb-4 shadow-xl">
          {savedPin ? (
            <Lock className="w-8 h-8 animate-pulse" />
          ) : (
            <ShieldCheck className="w-8 h-8 text-amber-500" />
          )}
        </div>
        
        <h2 className="text-xl font-extrabold tracking-tight text-slate-100">
          {savedPin ? 'Security Pin Required' : isConfirming ? 'Confirm Security PIN' : 'Create Security PIN'}
        </h2>
        
        <p className="text-xs text-slate-400 mt-1 max-w-xs mx-auto">
          {savedPin 
            ? 'CypherChat is locked to protect your conversations.' 
            : isConfirming 
              ? 'Re-enter your 4-digit PIN to confirm setup.' 
              : 'Choose a 4-digit PIN to lock your local chat database.'
          }
        </p>
      </div>

      {/* Code Display Area */}
      <div className="w-full max-w-xs flex flex-col items-center gap-4 mb-6">
        {/* Shaking PIN dots */}
        <div className={`flex justify-center gap-4 py-2 ${shake ? 'animate-shake' : ''}`}>
          {[0, 1, 2, 3].map((index) => {
            const hasVal = pin.length > index;
            return (
              <div
                key={index}
                className={`w-4 h-4 rounded-full border-2 transition-all duration-150 ${
                  hasVal 
                    ? 'bg-amber-500 border-amber-500 scale-110 shadow-lg shadow-amber-500/20' 
                    : 'border-slate-800 bg-slate-900/40'
                }`}
              />
            );
          })}
        </div>

        {/* Clear feedback text */}
        {error ? (
          <p className="text-xs font-semibold text-rose-500 text-center animate-shake bg-rose-500/10 border border-rose-500/20 px-3 py-1 rounded-full">
            {error}
          </p>
        ) : (
          <p className="text-xs font-mono text-slate-500">
            {isConfirming ? 'Confirmation Step' : savedPin ? 'Cypher Tunnel Encrypted' : 'Device Security'}
          </p>
        )}


      </div>

      {/* Number Pad Grid */}
      <div className="w-full max-w-xs grid grid-cols-3 gap-3 mb-6">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((num) => (
          <button
            key={num}
            type="button"
            onClick={() => handleNumberClick(num)}
            className="w-16 h-16 rounded-full bg-slate-900/60 hover:bg-slate-900 text-slate-200 hover:text-amber-500 font-extrabold text-lg flex items-center justify-center border border-slate-900 hover:border-slate-800 transition-all active:scale-95 mx-auto shadow-md"
          >
            {num}
          </button>
        ))}

        {/* Action Row */}
        <button
          type="button"
          onClick={handleClear}
          className="w-16 h-16 rounded-full hover:bg-slate-900/40 text-slate-500 hover:text-slate-300 text-xs font-medium flex items-center justify-center transition-colors mx-auto"
          title="Clear all digits"
        >
          {isConfirming ? <RefreshCw className="w-4 h-4" /> : 'RESET'}
        </button>

        <button
          type="button"
          onClick={() => handleNumberClick('0')}
          className="w-16 h-16 rounded-full bg-slate-900/60 hover:bg-slate-900 text-slate-200 hover:text-amber-500 font-extrabold text-lg flex items-center justify-center border border-slate-900 hover:border-slate-800 transition-all active:scale-95 mx-auto shadow-md"
        >
          0
        </button>

        <button
          type="button"
          onClick={handleBackspace}
          className="w-16 h-16 rounded-full hover:bg-slate-900/40 text-slate-500 hover:text-slate-300 flex items-center justify-center transition-colors mx-auto"
          title="Delete last digit"
        >
          <Delete className="w-5 h-5" />
        </button>
      </div>

      {/* Disclaimer details */}
      <div className="text-[10px] text-slate-600 font-mono text-center max-w-xs mt-4">
        {savedPin 
          ? 'Enter your PIN to verify device ownership. For security, your app logs are fully isolated client-side.'
          : 'Warning: Write this PIN down. If lost, you must re-authenticate and clear your local vault keys.'
        }
      </div>
    </div>
  );
}
