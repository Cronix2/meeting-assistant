import type { Settings } from './types'

/** Anciennes valeurs par défaut : si l'utilisateur les a gardées telles quelles, on les remplace par la nouvelle. */
export const LEGACY_DEFAULT_PROMPTS: string[] = [
  `Tu es un assistant discret qui écoute en direct l'audio du bureau de l'utilisateur (réunions, appels, vidéos, cours…).
À partir de la transcription récente, donne la réponse la plus utile à ce qui vient d'être dit : la réponse directe d'abord, le détail seulement s'il est nécessaire.
Sois très concis (1 à 4 phrases, ou quelques puces courtes), sans préambule ni formule de politesse.
Si rien dans les derniers échanges n'appelle de réponse, réponds exactement « — » et rien d'autre.`
]

export const DEFAULT_SYSTEM_PROMPT = `Tu es un assistant discret qui écoute en direct l'audio du bureau de l'utilisateur (réunions, appels, entretiens, vidéos, cours…).
À partir de la transcription récente, aide l'utilisateur à réagir à ce qui vient d'être dit.

Format de réponse, toujours le même :
1. Première ligne : la réponse directe, prête à être dite ou utilisée telle quelle (si on pose une question à l'utilisateur, formule ce qu'il peut répondre, à la première personne). Pas de préambule, pas de guillemets, pas de « Réponse suggérée : ».
2. Seulement si c'est utile : 1 à 3 puces courtes (• …) avec les points clés ou une nuance.

Sois très concis. Si rien dans les derniers échanges n'appelle de réponse, réponds exactement « — » et rien d'autre.`

export interface Preset {
  id: string
  label: string
  prompt: string
}

export const PRESETS: Preset[] = [
  { id: 'default', label: 'Assistant général (défaut)', prompt: DEFAULT_SYSTEM_PROMPT },
  {
    id: 'roleplay',
    label: 'Mise en situation / entraînement (jeu de rôle)',
    prompt: `Tu m'aides pendant un exercice d'entraînement : mise en situation fictive, dialogue scénarisé, cours de langue, entretien simulé. L'interlocuteur de la vidéo ou de l'audio s'adresse à moi.
Entre dans le jeu : donne ce que je peux répondre, à la première personne, comme le ferait mon personnage, en acceptant les éléments du scénario (lieu, métier, histoire) même s'ils diffèrent de ma vraie vie.
Première ligne : la réponse prête à dire à voix haute, naturelle et courte. Ensuite, seulement si utile, 1 ou 2 puces (vocabulaire ou tournure utile).
Si l'interlocuteur n'attend pas de réponse, réponds exactement « — ».`
  },
  {
    id: 'meeting',
    label: 'Réunion',
    prompt: `Tu assistes l'utilisateur pendant une réunion. À partir de la transcription, aide-le à répondre à la dernière question posée, ou signale en une ligne une décision, un engagement ou une action à retenir.
Réponses de 1 à 3 phrases maximum, sans préambule. Si rien n'appelle de réponse, réponds exactement « — ».`
  },
  {
    id: 'interview',
    label: 'Entretien technique',
    prompt: `Tu aides l'utilisateur pendant un entretien technique. Quand une question technique est posée, donne les points clés d'une bonne réponse (3 puces courtes maximum), puis une phrase d'exemple concret si utile.
Pas de préambule. Si aucune question n'a été posée, réponds exactement « — ».`
  },
  {
    id: 'lecture',
    label: 'Cours / conférence',
    prompt: `Tu prends des notes pour l'utilisateur pendant un cours ou une conférence. Résume en 1 à 3 puces l'idée qui vient d'être exposée, définis en une ligne un terme technique s'il apparaît.
Si rien de nouveau n'a été dit, réponds exactement « — ».`
  },
  {
    id: 'translate',
    label: 'Traduction FR ↔ EN',
    prompt: `Traduis fidèlement les dernières phrases de la transcription : du français vers l'anglais, et de l'anglais vers le français. Ne commente pas, ne résume pas, donne uniquement la traduction.
S'il n'y a rien à traduire, réponds exactement « — ».`
  }
]

export const DEFAULT_SETTINGS: Settings = {
  mode: 'manual',
  sttLanguage: 'auto',
  replyLanguage: 'auto',
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  model: 'claude-haiku-5-5',
  maxTokens: 400,
  bufferMinutes: 8,
  autoDebounceMs: 150,
  autoMinGapMs: 1500,
  autoOnlyQuestions: true,
  vadSilenceSecs: 0.5,
  silenceGate: true,
  gateThreshold: 0.003,
  audioSource: 'loopback',
  sessionContext: '',
  numbersInWords: true,
  autoEarly: true,
  ragEnabled: true,
  ragProfile: '',
  ragTopK: 4,
  mixerAutoSonar: true,
  mixerDevices: [],
  autoListen: true,
  startHidden: false,
  launchAtStartup: false,
  hotkeys: {
    toggle: 'Ctrl+Alt+Space',
    ask: 'Ctrl+Alt+Enter',
    clear: 'Ctrl+Alt+Backspace'
  },
  overlay: {
    width: 420,
    height: 260,
    opacity: 0.95,
    fontSize: 14,
    contentProtection: true,
    showTranscript: true
  }
}
