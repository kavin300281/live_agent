import React, { useState, useRef, useEffect, useCallback } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from "@google/genai";
import { Mic, MicOff, Video, VideoOff, Play, Square, Loader2, MessageSquare, Camera, FileText, Upload, X, Send, Image as ImageIcon, LogIn, LogOut, History, User as UserIcon, Trash2 } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { AudioProcessor, AudioPlayer } from './utils/audio-processor';
import { VisionProcessor } from './utils/vision-processor';
import { 
  auth, 
  db, 
  loginWithGoogle, 
  logout, 
  onAuthStateChanged, 
  collection, 
  doc, 
  setDoc, 
  addDoc, 
  serverTimestamp, 
  query, 
  where, 
  orderBy, 
  onSnapshot,
  User,
  OperationType,
  handleFirestoreError
} from './firebase';

const MODEL_NAME = "gemini-2.5-flash-native-audio-preview-09-2025";

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isMicOn, setIsMicOn] = useState(true);
  const [isCameraOn, setIsCameraOn] = useState(false);
  const [transcript, setTranscript] = useState<string>("");
  const [aiTranscript, setAiTranscript] = useState<string>("");
  const [isThinking, setIsThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [documentContext, setDocumentContext] = useState<string>("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [textInput, setTextInput] = useState<string>("");
  const [isSending, setIsSending] = useState(false);
  const [sessions, setSessions] = useState<any[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [activeTab, setActiveTab] = useState<'live' | 'history'>('live');
  const [historicalMessages, setHistoricalMessages] = useState<any[]>([]);

  const videoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioProcessor = useRef<AudioProcessor | null>(null);
  const audioPlayer = useRef<AudioPlayer | null>(null);
  const visionProcessor = useRef<VisionProcessor | null>(null);
  const sessionRef = useRef<any>(null);
  const visionIntervalRef = useRef<number | null>(null);
  const currentAiTurnRef = useRef<string>("");
  const currentUserTurnRef = useRef<string>("");

  // Initialize processors and Auth
  useEffect(() => {
    audioProcessor.current = new AudioProcessor();
    audioPlayer.current = new AudioPlayer();
    visionProcessor.current = new VisionProcessor();

    const unsubscribeAuth = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setIsAuthReady(true);
      if (u) {
        // Create/Update user profile
        setDoc(doc(db, 'users', u.uid), {
          uid: u.uid,
          email: u.email,
          displayName: u.displayName,
          photoURL: u.photoURL,
          createdAt: serverTimestamp()
        }, { merge: true }).catch(err => handleFirestoreError(err, OperationType.WRITE, `users/${u.uid}`));
      }
    });

    return () => {
      unsubscribeAuth();
      stopSession();
    };
  }, []);

  // Load session history
  useEffect(() => {
    if (!user) return;

    const q = query(
      collection(db, 'sessions'),
      where('uid', '==', user.uid),
      orderBy('updatedAt', 'desc')
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const sessionData = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      setSessions(sessionData);
    }, (err) => handleFirestoreError(err, OperationType.LIST, 'sessions'));

    return () => unsubscribe();
  }, [user]);

  // Load messages for historical view
  useEffect(() => {
    if (!currentSessionId || activeTab !== 'history') return;

    const q = query(
      collection(db, `sessions/${currentSessionId}/messages`),
      orderBy('timestamp', 'asc')
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const messages = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      setHistoricalMessages(messages);
    }, (err) => handleFirestoreError(err, OperationType.LIST, `sessions/${currentSessionId}/messages`));

    return () => unsubscribe();
  }, [currentSessionId, activeTab]);

  const saveMessage = async (role: 'user' | 'model', text: string) => {
    if (!currentSessionId || !text.trim()) return;

    try {
      await addDoc(collection(db, `sessions/${currentSessionId}/messages`), {
        sessionId: currentSessionId,
        role,
        text,
        timestamp: serverTimestamp()
      });

      // Update session timestamp
      await setDoc(doc(db, 'sessions', currentSessionId), {
        updatedAt: serverTimestamp()
      }, { merge: true });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `sessions/${currentSessionId}/messages`);
    }
  };

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        setIsCameraOn(true);
      }
    } catch (err) {
      console.error("Error accessing camera:", err);
      setError("Could not access camera.");
    }
  };

  const stopCamera = () => {
    if (videoRef.current && videoRef.current.srcObject) {
      const stream = videoRef.current.srcObject as MediaStream;
      stream.getTracks().forEach(track => track.stop());
      videoRef.current.srcObject = null;
    }
    setIsCameraOn(false);
    if (visionIntervalRef.current) {
      window.clearInterval(visionIntervalRef.current);
      visionIntervalRef.current = null;
    }
  };

  const handleMessage = useCallback((message: LiveServerMessage) => {
    // Handle audio output
    const serverContent = message.serverContent;
    if (!serverContent) return;

    const modelTurn = serverContent.modelTurn;
    const base64Audio = modelTurn?.parts?.find(p => p.inlineData)?.inlineData?.data;
    if (base64Audio && audioPlayer.current) {
      audioPlayer.current.playChunk(base64Audio);
    }

    // Handle AI transcription
    let newAiText = "";
    let hasThought = false;

    // 1. From modelTurn parts (text responses)
    if (modelTurn?.parts) {
      modelTurn.parts.forEach(part => {
        if (part.thought) {
          hasThought = true;
        }
        if (part.text && !part.thought) {
          newAiText += part.text;
        }
      });
    }

    // 2. From outputTranscription (audio responses)
    const outputTranscription = serverContent.outputTranscription;
    if (outputTranscription?.text) {
      newAiText += outputTranscription.text;
    }

    if (hasThought && !newAiText) {
      setIsThinking(true);
    }

    if (newAiText) {
      setIsThinking(false);
      
      // If this is the start of a new turn, clear the old one
      if (currentAiTurnRef.current === "" && aiTranscript !== "") {
        setAiTranscript("");
      }

      // Append to current turn with space handling
      const separator = currentAiTurnRef.current && !currentAiTurnRef.current.endsWith(' ') && !newAiText.startsWith(' ') ? ' ' : '';
      currentAiTurnRef.current += separator + newAiText;
      setAiTranscript(currentAiTurnRef.current);
    }

    // Handle user transcription from inputTranscription
    const inputTranscription = serverContent.inputTranscription;
    if (inputTranscription) {
      setIsThinking(false);
      const newUserText = inputTranscription.text || "";
      
      if (newUserText) {
        // If this is the start of a new turn (previous was finished), clear the old one
        if (currentUserTurnRef.current === "" && transcript !== "") {
          setTranscript("");
        }
        
        // Append to current turn with space handling
        const separator = currentUserTurnRef.current && !currentUserTurnRef.current.endsWith(' ') && !newUserText.startsWith(' ') ? ' ' : '';
        currentUserTurnRef.current += separator + newUserText;
        setTranscript(currentUserTurnRef.current);
      }
      
      if (inputTranscription.finished) {
        // Save user message when finished
        if (currentUserTurnRef.current) {
          saveMessage('user', currentUserTurnRef.current);
        }
        // We clear the ref so the next chunk starts fresh, but keep state for UI
        currentUserTurnRef.current = "";
      }
    }

    // Handle interruption
    if (serverContent.interrupted) {
      audioPlayer.current?.stop();
      setIsThinking(false);
      currentAiTurnRef.current = "";
    }

    // Handle turn completion
    if (serverContent.turnComplete) {
      setIsThinking(false);
      // Save AI message when turn is complete
      if (currentAiTurnRef.current) {
        saveMessage('model', currentAiTurnRef.current);
      }
      currentUserTurnRef.current = "";
      currentAiTurnRef.current = "";
    }
  }, []);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const isImage = file.type.startsWith('image/');
    setFileName(file.name);

    const reader = new FileReader();
    reader.onload = (event) => {
      const base64Data = (event.target?.result as string).split(',')[1];
      
      if (isImage) {
        if (isConnected && sessionRef.current) {
          sessionRef.current.sendRealtimeInput({
            media: { data: base64Data, mimeType: file.type }
          });
        } else {
          setError("Connect to a session to send images.");
        }
      } else {
        // Handle as text context
        const content = atob(base64Data);
        setDocumentContext(content.slice(0, 10000));
      }
    };

    if (isImage) {
      reader.readAsDataURL(file);
    } else {
      reader.readAsDataURL(file); // We'll decode it back to text
    }
  };

  const sendTextMessage = async () => {
    if (!textInput.trim() || !sessionRef.current || !isConnected) return;

    // Finalize any pending turns before sending new text
    if (currentAiTurnRef.current || currentUserTurnRef.current) {
      currentAiTurnRef.current = "";
      currentUserTurnRef.current = "";
      setAiTranscript("");
    }

    setIsSending(true);
    try {
      sessionRef.current.sendRealtimeInput({
        text: textInput
      });
      // Save text input as message
      saveMessage('user', textInput);
      setTextInput("");
    } catch (err) {
      console.error("Error sending text:", err);
      setError("Failed to send message.");
    } finally {
      setIsSending(false);
    }
  };

  const removeDocument = () => {
    setFileName(null);
    setDocumentContext("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const startSession = async () => {
    if (!user) {
      setError("Please log in to start a session.");
      return;
    }

    setIsConnecting(true);
    setError(null);
    setTranscript("");
    setAiTranscript("");
    setActiveTab('live');

    try {
      // Create a new session in Firestore
      const sessionDoc = await addDoc(collection(db, 'sessions'), {
        uid: user.uid,
        title: `Session ${new Date().toLocaleString()}`,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
      setCurrentSessionId(sessionDoc.id);

      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      
      const session = await ai.live.connect({
        model: MODEL_NAME,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } },
          },
          systemInstruction: `You are a helpful, friendly AI assistant. You can see through the user's camera and hear them. Respond naturally and concisely. You can be interrupted. DO NOT share your internal reasoning, plans, or "thinking" process with the user. Only provide the final response. ${documentContext ? `\n\nHere is some additional context from a document provided by the user:\n${documentContext}` : ""}`,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            setIsConnected(true);
            setIsConnecting(false);
            
            // Start audio recording
            audioProcessor.current?.startRecording((base64Data) => {
              if (isMicOn) {
                session.sendRealtimeInput({
                  media: { data: base64Data, mimeType: 'audio/pcm;rate=16000' }
                });
              }
            });

            // Start vision loop if camera is on
            if (isCameraOn && videoRef.current) {
              visionIntervalRef.current = window.setInterval(() => {
                const frame = visionProcessor.current?.captureFrame(videoRef.current!);
                if (frame) {
                  session.sendRealtimeInput({
                    media: { data: frame, mimeType: 'image/jpeg' }
                  });
                }
              }, 1000); // Send frame every second
            }
          },
          onmessage: handleMessage,
          onclose: () => {
            stopSession();
          },
          onerror: (err) => {
            console.error("Live API Error:", err);
            setError("Connection error. Please try again.");
            stopSession();
          }
        }
      });

      sessionRef.current = session;
    } catch (err) {
      console.error("Failed to connect:", err);
      setError("Failed to initialize Gemini Live session.");
      setIsConnecting(false);
    }
  };

  const stopSession = () => {
    sessionRef.current?.close();
    sessionRef.current = null;
    audioProcessor.current?.stopRecording();
    audioPlayer.current?.stop();
    if (visionIntervalRef.current) {
      window.clearInterval(visionIntervalRef.current);
      visionIntervalRef.current = null;
    }
    setIsConnected(false);
    setIsConnecting(false);
    setTranscript("");
    setAiTranscript("");
    currentAiTurnRef.current = "";
    currentUserTurnRef.current = "";
  };

  const toggleMic = () => setIsMicOn(!isMicOn);
  
  const toggleCamera = () => {
    if (isCameraOn) {
      stopCamera();
    } else {
      startCamera();
    }
  };

  if (!isAuthReady) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-emerald-500 animate-spin" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-6">
        <div className="max-w-md w-full space-y-8 text-center">
          <div className="space-y-4">
            <div className="w-20 h-20 bg-emerald-500 rounded-3xl mx-auto flex items-center justify-center shadow-2xl shadow-emerald-500/20">
              <Mic className="w-10 h-10 text-zinc-950" />
            </div>
            <h1 className="text-4xl font-bold tracking-tight">Gemini Live</h1>
            <p className="text-zinc-500">Sign in to start low-latency multimodal conversations with Gemini.</p>
          </div>
          <button
            onClick={loginWithGoogle}
            className="w-full flex items-center justify-center gap-3 px-6 py-4 bg-white text-zinc-950 rounded-2xl font-bold hover:bg-zinc-200 transition-all shadow-xl"
          >
            <LogIn className="w-5 h-5" />
            Continue with Google
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans selection:bg-emerald-500/30 flex">
      {/* Sidebar for History */}
      <AnimatePresence>
        {showHistory && (
          <motion.aside
            initial={{ x: -320 }}
            animate={{ x: 0 }}
            exit={{ x: -320 }}
            className="w-80 border-r border-white/5 bg-zinc-900/50 backdrop-blur-xl fixed inset-y-0 left-0 z-[60] flex flex-col"
          >
            <div className="p-6 border-b border-white/5 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <History className="w-4 h-4 text-emerald-400" />
                <h2 className="font-bold text-sm uppercase tracking-widest">History</h2>
              </div>
              <button onClick={() => setShowHistory(false)} className="p-2 hover:bg-white/5 rounded-lg">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-2">
              {sessions.length === 0 ? (
                <div className="text-center py-12 text-zinc-600">
                  <p className="text-xs">No sessions yet</p>
                </div>
              ) : (
                sessions.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => {
                      setCurrentSessionId(s.id);
                      setActiveTab('history');
                      setShowHistory(false);
                    }}
                    className={`w-full text-left p-4 rounded-2xl transition-all group ${
                      currentSessionId === s.id && activeTab === 'history'
                        ? 'bg-emerald-500/10 border border-emerald-500/20'
                        : 'hover:bg-white/5 border border-transparent'
                    }`}
                  >
                    <p className="text-sm font-medium truncate text-zinc-200 group-hover:text-emerald-400">
                      {s.title}
                    </p>
                    <p className="text-[10px] text-zinc-500 mt-1">
                      {s.updatedAt?.toDate().toLocaleString() || 'Just now'}
                    </p>
                  </button>
                ))
              )}
            </div>
          </motion.aside>
        )}
      </AnimatePresence>

      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <header className="border-b border-white/5 bg-zinc-900/50 backdrop-blur-md sticky top-0 z-50">
          <div className="max-w-5xl mx-auto px-6 h-20 flex items-center justify-between">
            <div className="flex items-center gap-4">
              <button 
                onClick={() => setShowHistory(true)}
                className="p-2 hover:bg-white/5 rounded-xl transition-colors"
              >
                <History className="w-6 h-6 text-zinc-400" />
              </button>
              <div className="w-10 h-10 bg-emerald-500 rounded-xl flex items-center justify-center shadow-lg shadow-emerald-500/20">
                <Mic className="w-6 h-6 text-zinc-950" />
              </div>
              <div className="flex flex-col">
                <h1 className="font-bold tracking-tight text-xl">Gemini Live</h1>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-emerald-500/80">2.5 Flash Native Audio</span>
                </div>
              </div>
            </div>
            
            <div className="flex items-center gap-4">
              {isConnected && (
                <div className="flex items-center gap-2 px-3 py-1 bg-emerald-500/10 border border-emerald-500/20 rounded-full">
                  <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse" />
                  <span className="text-xs font-medium text-emerald-400 uppercase tracking-wider">Live</span>
                </div>
              )}
              
              <div className="flex items-center gap-3 pl-4 border-l border-white/5">
                <div className="flex flex-col items-end hidden sm:flex">
                  <span className="text-xs font-bold text-zinc-200">{user.displayName}</span>
                  <button onClick={logout} className="text-[10px] text-zinc-500 hover:text-red-400 transition-colors uppercase tracking-widest font-bold">Sign Out</button>
                </div>
                <img src={user.photoURL || ''} alt="" className="w-10 h-10 rounded-xl border border-white/10" />
              </div>

              <button 
                onClick={isConnected ? stopSession : startSession}
                disabled={isConnecting}
                className={`flex items-center gap-2 px-4 py-2 rounded-xl font-medium transition-all ${
                  isConnected 
                    ? "bg-zinc-800 hover:bg-zinc-700 text-zinc-100" 
                    : "bg-emerald-500 hover:bg-emerald-400 text-zinc-950 shadow-lg shadow-emerald-500/20"
                } disabled:opacity-50 disabled:cursor-not-allowed`}
              >
                {isConnecting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : isConnected ? (
                  <Square className="w-4 h-4 fill-current" />
                ) : (
                  <Play className="w-4 h-4 fill-current" />
                )}
                {isConnecting ? "Connecting..." : isConnected ? "End Session" : "Start Live"}
              </button>
            </div>
          </div>
        </header>

        <main className="max-w-5xl mx-auto px-6 py-12 w-full">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            {/* Left Column: Visuals */}
            <div className="space-y-6">
              {activeTab === 'live' ? (
                <>
                  <div className="relative aspect-video bg-zinc-900 rounded-3xl overflow-hidden border border-white/5 shadow-2xl group">
                    <video 
                      ref={videoRef} 
                      autoPlay 
                      playsInline 
                      muted 
                      className={`w-full h-full object-cover transition-opacity duration-500 ${isCameraOn ? 'opacity-100' : 'opacity-0'}`}
                    />
                    
                    {!isCameraOn && (
                      <div className="absolute inset-0 flex flex-col items-center justify-center text-zinc-500 gap-4">
                        <div className="w-16 h-16 bg-zinc-800 rounded-full flex items-center justify-center">
                          <VideoOff className="w-8 h-8" />
                        </div>
                        <p className="text-sm font-medium">Camera is off</p>
                      </div>
                    )}

                    {/* Camera Controls Overlay */}
                    <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-4 p-2 bg-zinc-900/80 backdrop-blur-xl border border-white/10 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                      <button 
                        onClick={toggleMic}
                        className={`p-3 rounded-xl transition-colors ${isMicOn ? 'bg-emerald-500/10 text-emerald-400' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'}`}
                      >
                        {isMicOn ? <Mic className="w-5 h-5" /> : <MicOff className="w-5 h-5" />}
                      </button>
                      <button 
                        onClick={toggleCamera}
                        className={`p-3 rounded-xl transition-colors ${isCameraOn ? 'bg-emerald-500/10 text-emerald-400' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'}`}
                      >
                        {isCameraOn ? <Video className="w-5 h-5" /> : <VideoOff className="w-5 h-5" />}
                      </button>
                    </div>
                  </div>

                  {/* Status Cards */}
                  <div className="grid grid-cols-2 gap-4">
                    <div className="p-6 bg-zinc-900/50 border border-white/5 rounded-3xl">
                      <div className="flex items-center gap-3 mb-4">
                        <div className="p-2 bg-emerald-500/10 rounded-lg">
                          <Mic className="w-4 h-4 text-emerald-400" />
                        </div>
                        <span className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Audio</span>
                      </div>
                      <p className="text-sm font-medium text-zinc-300">
                        {isConnected ? (isMicOn ? "Listening..." : "Muted") : "Inactive"}
                      </p>
                    </div>
                    <div className="p-6 bg-zinc-900/50 border border-white/5 rounded-3xl">
                      <div className="flex items-center gap-3 mb-4">
                        <div className="p-2 bg-emerald-500/10 rounded-lg">
                          <Camera className="w-4 h-4 text-emerald-400" />
                        </div>
                        <span className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Vision</span>
                      </div>
                      <p className="text-sm font-medium text-zinc-300">
                        {isConnected ? (isCameraOn ? "Seeing" : "Blind") : "Inactive"}
                      </p>
                    </div>
                  </div>
                </>
              ) : (
                <div className="p-8 bg-zinc-900/50 border border-white/5 rounded-3xl h-full flex flex-col">
                  <div className="flex items-center justify-between mb-8">
                    <div className="flex items-center gap-3">
                      <History className="w-5 h-5 text-emerald-400" />
                      <h2 className="font-bold">Session History</h2>
                    </div>
                    <button 
                      onClick={() => setActiveTab('live')}
                      className="text-xs font-bold text-emerald-400 hover:text-emerald-300 uppercase tracking-widest"
                    >
                      Back to Live
                    </button>
                  </div>
                  <div className="flex-1 overflow-y-auto space-y-4 pr-2 scrollbar-hide">
                    {historicalMessages.map((msg) => (
                      <div key={msg.id} className={`space-y-1 ${msg.role === 'user' ? 'text-right' : 'text-left'}`}>
                        <span className={`text-[10px] font-bold uppercase tracking-widest ${msg.role === 'user' ? 'text-emerald-500/50' : 'text-zinc-500'}`}>
                          {msg.role === 'user' ? 'You' : 'Gemini'}
                        </span>
                        <p className={`text-sm ${msg.role === 'user' ? 'text-zinc-400 italic' : 'text-zinc-300'}`}>
                          {msg.role === 'user' ? `"${msg.text}"` : msg.text}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Text Input Section */}
              <div className="p-6 bg-zinc-900/50 border border-white/5 rounded-3xl space-y-4">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-emerald-500/10 rounded-lg">
                    <MessageSquare className="w-4 h-4 text-emerald-400" />
                  </div>
                  <span className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Text Input</span>
                </div>
                <div className="relative">
                  <textarea
                    value={textInput}
                    onChange={(e) => setTextInput(e.target.value)}
                    placeholder={isConnected ? "Type a message to Gemini..." : "Connect to start typing"}
                    disabled={!isConnected || isSending}
                    className="w-full bg-zinc-950 border border-white/10 rounded-2xl p-4 pr-12 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-emerald-500/50 transition-all resize-none h-24"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        sendTextMessage();
                      }
                    }}
                  />
                  <button
                    onClick={sendTextMessage}
                    disabled={!isConnected || !textInput.trim() || isSending}
                    className="absolute bottom-4 right-4 p-2 bg-emerald-500 text-zinc-950 rounded-xl hover:bg-emerald-400 disabled:opacity-50 disabled:hover:bg-emerald-500 transition-all"
                  >
                    {isSending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            </div>

            {/* Right Column: Interaction */}
            <div className="flex flex-col h-full min-h-[400px]">
              <div className="flex-1 bg-zinc-900/50 border border-white/5 rounded-3xl p-8 relative overflow-hidden flex flex-col">
                <div className="flex items-center gap-3 mb-6">
                  <MessageSquare className="w-5 h-5 text-emerald-400" />
                  <h2 className="font-semibold">AI Response</h2>
                </div>

                <div className="flex-1 overflow-y-auto space-y-6 pr-2 scrollbar-hide">
                  <AnimatePresence mode="popLayout">
                    {transcript && (
                      <motion.div
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="space-y-2"
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] font-bold uppercase tracking-widest text-emerald-500/50">You</span>
                        </div>
                        <p className="text-sm text-zinc-400 italic">
                          "{transcript}"
                        </p>
                      </motion.div>
                    )}

                    {isThinking && !aiTranscript && (
                      <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="flex items-center gap-2 text-zinc-500 italic text-sm"
                      >
                        <motion.div
                          animate={{ opacity: [0.4, 1, 0.4] }}
                          transition={{ duration: 1.5, repeat: Infinity }}
                        >
                          Gemini is thinking...
                        </motion.div>
                      </motion.div>
                    )}
                    {aiTranscript ? (
                      <motion.div 
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="text-lg leading-relaxed text-zinc-300"
                      >
                        {aiTranscript}
                      </motion.div>
                    ) : (
                      <div className="h-full flex flex-col items-center justify-center text-zinc-500 text-center space-y-4">
                        <div className="w-12 h-12 bg-zinc-800/50 rounded-2xl flex items-center justify-center animate-pulse">
                          <Loader2 className="w-6 h-6 opacity-20" />
                        </div>
                        <p className="text-sm max-w-[200px]">
                          {isConnected ? "Waiting for Gemini to speak..." : "Start a session to begin talking"}
                        </p>
                      </div>
                    )}
                  </AnimatePresence>
                </div>

                {/* Error Message */}
                {error && (
                  <motion.div 
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="mt-6 p-4 bg-red-500/10 border border-red-500/20 rounded-2xl text-red-400 text-sm flex items-center gap-3"
                  >
                    <div className="w-1.5 h-1.5 bg-red-500 rounded-full" />
                    {error}
                  </motion.div>
                )}
              </div>
            </div>
          </div>
        </main>

        {/* Footer Info */}
        <footer className="max-w-5xl mx-auto px-6 py-12 border-t border-white/5">
          <div className="flex justify-between items-center">
            <p className="text-xs text-zinc-600 font-medium uppercase tracking-widest">Built with Google AI Studio</p>
            <div className="flex items-center gap-6">
              <div className="flex items-center gap-2">
                <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full" />
                <span className="text-xs font-medium text-zinc-500 uppercase tracking-wider">System Ready</span>
              </div>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}
