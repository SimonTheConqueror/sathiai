
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, Modality, type LiveServerMessage, Type, type FunctionDeclaration } from '@google/genai';
import { Subject } from './types';
import { SYSTEM_INSTRUCTIONS, SUBJECT_METADATA } from './constants';
import { createBlob, decode, decodeAudioData } from './services/audioService';

const displayTargetWordDeclaration: FunctionDeclaration = {
  name: 'displayTargetWord',
  parameters: {
    type: Type.OBJECT,
    description: 'Displays a specific word on the student screen for pronunciation practice.',
    properties: {
      word: {
        type: Type.STRING,
        description: 'The word to be practiced.',
      },
      language: {
        type: Type.STRING,
        description: 'The language of the word (English or Nepali).',
      },
    },
    required: ['word', 'language'],
  },
};

const App: React.FC = () => {
  const [selectedSubject, setSelectedSubject] = useState<Subject | null>(null);
  const [isActive, setIsActive] = useState(false);
  const [userTranscription, setUserTranscription] = useState('');
  const [modelTranscription, setModelTranscription] = useState('');
  const [isConnecting, setIsConnecting] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [targetWord, setTargetWord] = useState<{ word: string; language: string } | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [inputText, setInputText] = useState('');

  // Refs for audio processing
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const sessionRef = useRef<any>(null);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const nextStartTimeRef = useRef(0);
  const micStreamRef = useRef<MediaStream | null>(null);
  const isMutedRef = useRef(false);

  const toggleMute = () => {
    const nextMuted = !isMuted;
    setIsMuted(nextMuted);
    isMutedRef.current = nextMuted;
  };

  const stopSession = useCallback(() => {
    if (sessionRef.current) {
      try {
        sessionRef.current.close();
      } catch (e) {}
    }
    setIsActive(false);
    setIsConnecting(false);
    setIsMuted(false);
    isMutedRef.current = false;
    setTargetWord(null);
    setInputText('');
    
    // Cleanup audio
    if (inputAudioCtxRef.current) inputAudioCtxRef.current.close().catch(() => {});
    if (outputAudioCtxRef.current) outputAudioCtxRef.current.close().catch(() => {});
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach(track => track.stop());
    }
    
    inputAudioCtxRef.current = null;
    outputAudioCtxRef.current = null;
    micStreamRef.current = null;
    sessionRef.current = null;
  }, []);

  const handleApiKeySelection = async () => {
    try {
      // @ts-ignore
      const hasKey = await window.aistudio.hasSelectedApiKey();
      if (!hasKey) {
        // @ts-ignore
        await window.aistudio.openSelectKey();
      }
      return true;
    } catch (e) {
      console.error("API Key selection failed", e);
      return false;
    }
  };

  const handleSendMessage = () => {
    if (!inputText.trim() || !sessionRef.current) return;
    
    const textToSend = inputText.trim();
    sessionRef.current.sendRealtimeInput({
      text: textToSend
    });
    
    setUserTranscription(prev => prev + ` [Typed: ${textToSend}]`);
    setInputText('');
  };

  const startSession = async (subject: Subject) => {
    if (isConnecting) return;
    setIsConnecting(true);
    setErrorMsg(null);
    setSelectedSubject(subject);
    setIsMuted(false);
    isMutedRef.current = false;
    setTargetWord(null);
    setUserTranscription('');
    setModelTranscription('');

    // Pre-check for API key selection
    await handleApiKeySelection();

    try {
      const ai = new GoogleGenAI({ apiKey: import.meta.env.VITE_GEMINI_API_KEY });
      
      inputAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      outputAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: SYSTEM_INSTRUCTIONS(subject),
          tools: [{ functionDeclarations: [displayTargetWordDeclaration] }],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
          },
          // Enabling transcription for a better visual experience
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            setIsActive(true);
            setIsConnecting(false);
            
            const source = inputAudioCtxRef.current!.createMediaStreamSource(stream);
            const scriptProcessor = inputAudioCtxRef.current!.createScriptProcessor(4096, 1, 1);
            
            scriptProcessor.onaudioprocess = (e) => {
              if (isMutedRef.current) return;
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createBlob(inputData);
              sessionPromise.then(session => {
                session.sendRealtimeInput({ media: pcmBlob });
              });
            };
            
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputAudioCtxRef.current!.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            // Handle Tool Calls
            if (message.toolCall) {
              for (const fc of message.toolCall.functionCalls || []) {
                if (fc.name === 'displayTargetWord') {
                  const { word, language } = fc.args as any;
                  setTargetWord({ word, language });
                  
                  sessionPromise.then(session => {
                    session.sendToolResponse({
                      functionResponses: {
                        id: fc.id,
                        name: fc.name,
                        response: { result: "Word displayed successfully." },
                      }
                    });
                  });
                }
              }
            }

            // Handle Audio Data
            const audioData = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (audioData && outputAudioCtxRef.current) {
              const ctx = outputAudioCtxRef.current;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              
              const buffer = await decodeAudioData(decode(audioData), ctx, 24000, 1);
              const source = ctx.createBufferSource();
              source.buffer = buffer;
              source.connect(ctx.destination);
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += buffer.duration;
              sourcesRef.current.add(source);
              source.onended = () => sourcesRef.current.delete(source);
            }

            // Handle Transcriptions
            if (message.serverContent?.inputTranscription) {
              setUserTranscription(prev => prev + ' ' + message.serverContent!.inputTranscription!.text);
            }
            if (message.serverContent?.outputTranscription) {
              setModelTranscription(prev => prev + ' ' + message.serverContent!.outputTranscription!.text);
            }

            if (message.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => s.stop());
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
            }
          },
          onerror: (e: any) => {
            console.error('Session error:', e);
            const msg = e.message || 'Network error';
            
            // Handle "Operation is not implemented" or "Network error"
            if (msg.includes("Operation is not implemented") || msg.includes("Requested entity was not found")) {
              setErrorMsg("Sathi AI needs a specific key. Please select a Paid Project key from the dialog.");
              // @ts-ignore
              window.aistudio.openSelectKey().then(() => {
                 stopSession();
              });
            } else {
              setErrorMsg(msg);
              stopSession();
            }
          },
          onclose: () => {
            stopSession();
          }
        }
      });

      sessionRef.current = await sessionPromise;

    } catch (err: any) {
      console.error('Failed to start session:', err);
      setIsConnecting(false);
      setErrorMsg(err.message || 'Could not connect to Sathi AI');
      stopSession();
    }
  };

  useEffect(() => {
    return () => stopSession();
  }, [stopSession]);

  return (
    <div className="min-h-screen bg-sky-50 flex flex-col items-center p-4 md:p-8">
      {/* Header */}
      <header className="w-full max-w-4xl flex justify-between items-center mb-8">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 bg-orange-400 rounded-full flex items-center justify-center text-white text-2xl shadow-lg border-2 border-white">
            🎓
          </div>
          <div>
            <h1 className="text-3xl font-bold text-sky-900 tracking-tight">Sathi AI</h1>
            <p className="text-sky-600 font-medium text-xs md:text-sm">Your Personal Daju / Didy</p>
          </div>
        </div>
        {isActive && (
          <button 
            onClick={stopSession}
            className="px-4 md:px-6 py-2 bg-red-500 hover:bg-red-600 text-white font-bold rounded-full shadow-md transition-all flex items-center gap-2 text-sm md:text-base"
          >
            <span className="w-3 h-3 bg-white rounded-full animate-pulse" />
            Finish Lesson
          </button>
        )}
      </header>

      {/* Main Content Area */}
      <main className="w-full max-w-4xl flex-1 flex flex-col gap-6 relative">
        {!isActive ? (
          <div className="flex flex-col items-center animate-fade-in">
            {errorMsg && (
              <div className="w-full mb-6 p-4 bg-red-100 border border-red-200 text-red-700 rounded-2xl text-center font-bold animate-pulse">
                ⚠️ {errorMsg}
                <button onClick={() => setErrorMsg(null)} className="ml-4 underline text-sm hover:text-red-900">Dismiss</button>
              </div>
            )}
            
            <div className="bg-white p-6 md:p-8 rounded-3xl shadow-xl w-full border-t-8 border-orange-400">
              <h2 className="text-xl md:text-2xl font-bold text-sky-800 mb-2 text-center">Namaste! के पढ्ने त आज?</h2>
              <p className="text-sky-600 text-center mb-8 text-sm md:text-base">Choose a subject to start your lesson!</p>
              
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-6">
                {SUBJECT_METADATA.map((sub) => (
                  <button
                    key={sub.id}
                    onClick={() => startSession(sub.id)}
                    disabled={isConnecting}
                    className={`group relative p-6 rounded-2xl shadow-sm border-2 border-transparent hover:border-sky-300 hover:shadow-md transition-all text-left flex flex-col gap-2 ${sub.color} bg-opacity-10`}
                  >
                    <div className={`w-12 h-12 ${sub.color} rounded-xl flex items-center justify-center text-2xl shadow-sm mb-2 group-hover:scale-110 transition-transform`}>
                      {sub.icon}
                    </div>
                    <h3 className="text-lg font-bold text-sky-900">{sub.id}</h3>
                    <p className="text-xs md:text-sm text-sky-700">{sub.description}</p>
                    {isConnecting && selectedSubject === sub.id && (
                      <div className="absolute inset-0 bg-white/60 flex items-center justify-center rounded-2xl">
                        <div className="w-8 h-8 border-4 border-sky-500 border-t-transparent rounded-full animate-spin"></div>
                      </div>
                    )}
                  </button>
                ))}
              </div>
            </div>
            
            <div className="mt-8 text-center text-sky-500 max-w-md px-4">
              <p className="italic text-sm">"Always bilingual - explaining in Nepali first, then English. Just like a big brother or sister!"</p>
              <div className="mt-4 flex flex-col items-center gap-2">
                <p className="text-[10px] text-sky-300 font-bold uppercase">Important Info</p>
                <a href="https://ai.google.dev/gemini-api/docs/billing" target="_blank" rel="noreferrer" className="text-[10px] underline hover:text-sky-500">
                  Gemini Live API requires a Paid GCP Project key.
                </a>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-6 flex-1 h-full pb-32">
            {/* Subject Indicator */}
            <div className="bg-white px-6 py-4 rounded-2xl shadow-sm border-l-8 border-sky-400 flex items-center justify-between">
              <div>
                <span className="text-[10px] font-bold text-sky-400 uppercase tracking-widest">Currently Learning</span>
                <h2 className="text-lg md:text-xl font-bold text-sky-900">{selectedSubject}</h2>
              </div>
              <div className="flex gap-2">
                <div className={`h-10 w-10 ${isMuted ? 'bg-red-100 text-red-600' : 'bg-green-100 text-green-600'} rounded-full flex items-center justify-center ${!isMuted && 'animate-bounce-slow'} transition-colors`}>
                  {isMuted ? '🔇' : '🎤'}
                </div>
              </div>
            </div>

            {/* Pronunciation Target Word Card */}
            {targetWord && (
              <div className="bg-white p-8 rounded-3xl shadow-xl border-4 border-dashed border-pink-300 flex flex-col items-center animate-fade-in">
                <span className="text-xs font-bold text-pink-400 uppercase tracking-widest mb-2">Practice this word / यो शब्द भन्नुहोस्:</span>
                <h2 className="text-5xl md:text-7xl font-bold text-sky-900 mb-4 text-center tracking-tight">{targetWord.word}</h2>
                <div className="flex items-center gap-2 px-4 py-1 bg-pink-100 text-pink-700 rounded-full font-bold text-sm">
                  <span>{targetWord.language === 'Nepali' ? '🇳🇵' : '🇬🇧'}</span>
                  {targetWord.language}
                </div>
              </div>
            )}

            {/* Interaction Box */}
            <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-6 min-h-[300px]">
              {/* AI Side */}
              <div className="bg-white p-5 md:p-6 rounded-3xl shadow-lg border-2 border-sky-100 flex flex-col min-h-[150px]">
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-8 h-8 md:w-10 md:h-10 bg-orange-100 rounded-full flex items-center justify-center text-lg md:text-xl">🤖</div>
                  <h3 className="font-bold text-sky-800 text-sm md:text-base">Sathi AI says:</h3>
                </div>
                <div className="flex-1 overflow-y-auto bg-sky-50 rounded-xl p-4 text-sky-900 leading-relaxed font-medium text-sm md:text-base">
                  {modelTranscription || "Wait a second, I'm thinking... 😊"}
                </div>
              </div>

              {/* Student Side */}
              <div className="bg-white p-5 md:p-6 rounded-3xl shadow-lg border-2 border-orange-100 flex flex-col min-h-[150px]">
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-8 h-8 md:w-10 md:h-10 bg-sky-100 rounded-full flex items-center justify-center text-lg md:text-xl">🧒</div>
                  <h3 className="font-bold text-orange-800 text-sm md:text-base">You:</h3>
                </div>
                <div className="flex-1 overflow-y-auto bg-orange-50 rounded-xl p-4 text-orange-900 leading-relaxed font-medium italic text-sm md:text-base mb-4">
                  {isMuted ? (
                    <span className="text-red-400 font-bold italic">Mic is OFF. Type your question below!</span>
                  ) : (
                    userTranscription || "I'm listening to you! Speak clearly or type below... 👂"
                  )}
                </div>
                {/* Typing Input */}
                <div className="mt-auto flex gap-2">
                  <input 
                    type="text"
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value)}
                    onKeyPress={(e) => e.key === 'Enter' && handleSendMessage()}
                    placeholder="Type a message..."
                    className="flex-1 px-4 py-2 rounded-full border-2 border-orange-200 focus:border-orange-400 focus:outline-none text-sm md:text-base"
                  />
                  <button 
                    onClick={handleSendMessage}
                    className="w-10 h-10 bg-orange-500 text-white rounded-full flex items-center justify-center shadow-md hover:bg-orange-600 transition-colors"
                  >
                    🚀
                  </button>
                </div>
              </div>
            </div>

            {/* Microphone Toggle FAB */}
            <div className="fixed bottom-10 left-1/2 -translate-x-1/2 z-50 flex flex-col items-center gap-2">
              <button
                onClick={toggleMute}
                className={`w-16 h-16 rounded-full shadow-2xl flex items-center justify-center transition-all transform active:scale-95 ${
                  isMuted 
                  ? 'bg-red-500 hover:bg-red-600 scale-90' 
                  : 'bg-sky-500 hover:bg-sky-600 scale-100'
                }`}
              >
                <span className="text-3xl text-white">
                  {isMuted ? '🔇' : '🎤'}
                </span>
                {!isMuted && (
                  <span className="absolute inset-0 rounded-full bg-sky-400 animate-ping opacity-25"></span>
                )}
              </button>
              <span className={`text-[10px] md:text-xs font-bold px-3 py-1 rounded-full shadow-sm border ${
                isMuted ? 'bg-red-100 text-red-700 border-red-200' : 'bg-sky-100 text-sky-700 border-sky-200'
              }`}>
                {isMuted ? 'MIC OFF - Tap to Speak' : 'MIC ON - Speaking...'}
              </span>
            </div>

            {/* Tips/Helper */}
            <div className="bg-amber-50 border border-amber-200 p-4 rounded-xl text-center mb-12 md:mb-0">
              <p className="text-amber-800 text-xs md:text-sm font-bold flex items-center justify-center gap-2">
                💡 Tip: Try to say the words after me when I say "Now you try!"
              </p>
            </div>
          </div>
        )}
      </main>

      {/* Footer Branding */}
      <footer className="mt-8 text-sky-400 text-[10px] md:text-xs font-medium pb-4">
        Made with ❤️ for the students of Nepal
      </footer>
    </div>
  );
};

export default App;
