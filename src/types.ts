export interface LoggedSet {
  weight: number | null
  reps: number | null
  done?: boolean
  weightTarget?: number | null
  repsTarget?: number | null
  status?: 'complete' | 'skipped' | 'pending'
}

export interface LoggedExercise {
  id: string
  name: string
  sets: LoggedSet[]
  notes?: string
  muscleGroupId?: number
  templateExerciseId?: string
}

export interface MuscleFeedback {
  muscleGroupId: number
  pump?: number // 0-2
  soreness?: number // -1 to 3
  workload?: number // 0-3
  recommendedSets?: number // imported/historical only, display-only
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
  mesoId?: string
  mesoWeek?: number
  mesoDayPosition?: number
  status?: 'complete' | 'partial' | 'skipped'
  bodyweight?: number
  muscleFeedback?: MuscleFeedback[]
  activity?: {
    type: string
    /** Discipline within a type, e.g. Bouldering / Top rope for Climbing. */
    style?: string
    durationMin: number
  }
}

/** Non-lifting sessions. Logged as a Workout carrying `activity` and no exercises,
 *  so they sync, appear in History, and reach the coach with no separate plumbing. */
export const ACTIVITY_TYPES: { type: string; icon: string; styles?: string[] }[] = [
  { type: 'Climbing', icon: '🧗', styles: ['Bouldering', 'Top rope', 'Lead', 'Trad'] },
  { type: 'Hiking', icon: '🥾' },
  { type: 'Walking', icon: '🚶' },
  { type: 'Running', icon: '🏃' },
  { type: 'Cycling', icon: '🚴' },
  { type: 'Swimming', icon: '🏊' },
  { type: 'Rowing', icon: '🚣' },
  { type: 'Elliptical', icon: '🌀' },
  { type: 'Stair climber', icon: '🪜' },
  { type: 'Yoga', icon: '🧘' },
  { type: 'Sports', icon: '⚽' },
  { type: 'Other', icon: '➕' },
]

export interface MuscleGroup {
  id: number
  name: string
  inferred?: boolean
}

export const MUSCLE_GROUPS: MuscleGroup[] = [
  { id: 1, name: 'Chest' },
  { id: 2, name: 'Back' },
  { id: 3, name: 'Triceps' },
  { id: 4, name: 'Biceps' },
  { id: 5, name: 'Side Delts', inferred: true },
  { id: 6, name: 'Quads' },
  { id: 7, name: 'Glutes', inferred: true },
  { id: 8, name: 'Hamstrings', inferred: true },
  { id: 9, name: 'Calves' },
  { id: 10, name: 'Traps', inferred: true },
  { id: 11, name: 'Forearms' },
  { id: 12, name: 'Abs' },
]

export interface MesoTemplateExercise {
  id: string
  name: string
  muscleGroupId?: number
  sets: number
  repTarget?: [number, number]
}

export interface MesoTemplateDay {
  id: string
  label: string
  exercises: MesoTemplateExercise[]
}

export interface MesoPriority {
  muscleGroupId: number
  type: 'grow' | 'maintain' | 'emphasize'
}

export interface Mesocycle {
  id: string
  name: string
  unit: 'lbs' | 'kg'
  weeksPlanned: number
  deloadWeek?: number
  days: MesoTemplateDay[]
  priorities: MesoPriority[]
  status: 'active' | 'complete'
  createdAt: number
  finishedAt?: number
  updatedAt: number
  deleted?: boolean
  imported?: boolean
  goal?: string
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
  coachNotes?: string
  muscleGroupNames?: Record<number, string>
  /** Exercises pinned to Best lifts regardless of how they rank. */
  keyLifts?: string[]
  dropboxToken?: string
  ai?: AISettings
  lastSyncAt?: number
}

export interface DailyMetric {
  date: string
  weight?: number
  bodyFat?: number
  muscle?: number
  leanMass?: number
  steps?: number
  sleepMin?: number
  updatedAt: number
  source?: 'samsung' | 'manual'
}

export interface CoachMessage {
  role: 'user' | 'assistant'
  content: string
  at: number
}

export interface CoachThread {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  philosophy: Philosophy
  weeks: number
  /** Overrides `weeks`: a single most-recent session, or the entire history. */
  scope?: 'last' | 'all'
  messages: CoachMessage[]
  deleted?: boolean
}

export interface CoachMemory {
  id: string
  facts: string[]
  updatedAt: number
}

export interface ActiveWorkout {
  id: string
  date: string
  startedAt: number
  name?: string
  exercises: LoggedExercise[]
  restEndsAt?: number
  restTotal?: number
  mesoId?: string
  mesoWeek?: number
  mesoDayPosition?: number
}

export const EXERCISE_PRESETS: string[] = [
  'Back Squat', 'Front Squat', 'Bench Press', 'Incline Bench Press',
  'Smith Machine Bench Press', 'Overhead Press', 'Deadlift', 'Romanian Deadlift', 'Barbell Row',
  'Pull-Up', 'Chin-Up', 'Lat Pulldown', 'Seated Cable Row',
  'Dumbbell Bench Press', 'Incline Dumbbell Press', 'Dumbbell Shoulder Press',
  'Dumbbell Row', 'Dumbbell Curl', 'Hammer Curl', 'Barbell Curl',
  'Triceps Pushdown', 'Skull Crusher', 'Overhead Triceps Extension',
  'Leg Press', 'Leg Curl', 'Leg Extension', 'Hip Thrust',
  'Lunge', 'Bulgarian Split Squat', 'Calf Raise', 'Face Pull',
  'Lateral Raise', 'Cable Fly', 'Chest Fly', 'Push-Up',
  'Dip', 'Plank', 'Hanging Leg Raise', 'Cable Crunch',
  'Farmer Carry', 'Kettlebell Swing', 'Cable Row', 'Machine Chest Press',

  // Chest
  'Smith Machine Incline Press', 'Decline Bench Press',
  'Incline Dumbbell Fly', 'Dumbbell Pullover', 'Low-to-High Cable Fly', 'Pec Deck',
  'Dumbbell Floor Press', 'Close Grip Bench Press',

  // Back
  'Assisted Pull-Up', 'Chest Supported Row', 'T-Bar Row', 'Single-Arm Dumbbell Row',
  'Straight-Arm Pulldown', 'Machine Row', 'Inverted Row',

  // Shoulders
  'Barbell Shrug', 'Dumbbell Shrug', 'Machine Shoulder Press', 'Smith Machine Shoulder Press',
  'Arnold Press', 'Cable Lateral Raise', 'Machine Lateral Raise', 'Rear Delt Fly',
  'Cable Rear Delt Fly', 'Upright Row', 'Dumbbell Front Raise',

  // Triceps
  'Dumbbell Skull Crusher', 'EZ Bar Skull Crusher', 'Cable Overhead Triceps Extension',
  'Machine Triceps Extension', 'Rope Pushdown', 'Single-Arm Cable Pushdown', 'Assisted Dip',
  'Dumbbell Kickback',

  // Biceps
  'Preacher Curl', 'Machine Preacher Curl', 'EZ Bar Curl', 'Cable Curl',
  'Incline Dumbbell Curl', 'Concentration Curl', 'Spider Curl', 'Reverse Curl',
  'Zottman Curl', 'Cable Rope Hammer Curl',

  // Forearms
  'Wrist Curl', 'Reverse Wrist Curl', 'Cable Wrist Curl', 'Wrist Roller', 'Plate Pinch',

  // Legs
  'Hack Squat', 'Smith Machine Squat', 'Goblet Squat', 'Seated Leg Curl', 'Lying Leg Curl',
  'Stiff-Legged Deadlift', 'Walking Lunge', 'Reverse Lunge', 'Dumbbell Step-Up',
  'Glute Kickback', 'Cable Pull-Through', 'Sissy Squat', 'Seated Calf Raise',
  'Standing Calf Raise', 'Single-Leg Calf Raise', 'Adductor Machine', 'Abductor Machine',

  // Core
  'Machine Crunch', 'Sit-Up', 'Ab Wheel Rollout', 'Russian Twist', 'Cable Woodchop',
  'Dead Bug', 'Side Plank',
]
