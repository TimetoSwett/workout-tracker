export interface LoggedSet {
  weight: number | null
  reps: number | null
  done?: boolean
}

export interface LoggedExercise {
  id: string
  name: string
  sets: LoggedSet[]
  notes?: string
}

export interface Workout {
  id: string
  date: string
  startedAt: number
  endedAt?: number
  name?: string
  exercises: LoggedExercise[]
  notes?: string
  updatedAt: number
  deleted?: boolean
}

export interface TemplateExercise {
  name: string
  sets: number
}

export interface Template {
  id: string
  name: string
  exercises: TemplateExercise[]
}

export type AIProvider = 'anthropic' | 'openai'

export interface AISettings {
  provider: AIProvider
  model: string
  apiKey: string
  baseUrl?: string
}

export type Philosophy = 'balanced' | 'powerlifting' | 'hypertrophy' | 'hybrid'

export interface Profile {
  age?: number
  height?: number
  bodyweight?: number
  injuries?: string
}

export type GoalType = 'cut' | 'maintain' | 'bulk'

export interface Goal {
  type: GoalType
  ratePerWeek?: number
}

export interface Settings {
  units: 'lbs' | 'kg'
  restSeconds: number
  philosophy: Philosophy
  profile?: Profile
  goal?: Goal
  dropboxToken?: string
  ai?: AISettings
  lastSyncAt?: number
}

export interface DailyMetric {
  date: string
  weight?: number
  bodyFat?: number
  muscle?: number
  steps?: number
  sleepMin?: number
  updatedAt: number
  source?: 'samsung' | 'manual'
}

export interface ActiveWorkout {
  id: string
  date: string
  startedAt: number
  name?: string
  exercises: LoggedExercise[]
  restEndsAt?: number
  restTotal?: number
}

export const EXERCISE_PRESETS: string[] = [
  'Back Squat', 'Front Squat', 'Bench Press', 'Incline Bench Press',
  'Overhead Press', 'Deadlift', 'Romanian Deadlift', 'Barbell Row',
  'Pull-Up', 'Chin-Up', 'Lat Pulldown', 'Seated Cable Row',
  'Dumbbell Bench Press', 'Incline Dumbbell Press', 'Dumbbell Shoulder Press',
  'Dumbbell Row', 'Dumbbell Curl', 'Hammer Curl', 'Barbell Curl',
  'Triceps Pushdown', 'Skull Crusher', 'Overhead Triceps Extension',
  'Leg Press', 'Leg Curl', 'Leg Extension', 'Hip Thrust',
  'Lunge', 'Bulgarian Split Squat', 'Calf Raise', 'Face Pull',
  'Lateral Raise', 'Cable Fly', 'Chest Fly', 'Push-Up',
  'Dip', 'Plank', 'Hanging Leg Raise', 'Cable Crunch',
  'Farmer Carry', 'Kettlebell Swing', 'Cable Row', 'Machine Chest Press',
]
