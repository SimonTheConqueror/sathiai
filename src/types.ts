export const Subject = {
  Nepali: 'Nepali (मेरो नेपाली)',
  English: 'English',
  Maths: 'Maths (गणित)',
  Science: 'Science (विज्ञान)',
  Computer: 'Computer Science',
  Social: 'Social Studies (सामाजिक अध्ययन)',
  Pronunciation: 'Pronunciation Challenge (उच्चारण अभ्यास)',
  Health: 'Health (स्वास्थ्य अध्ययन)'
} as const;

export type Subject = typeof Subject[keyof typeof Subject];

export interface Message {
  role: 'user' | 'model';
  text: string;
}

export interface SessionConfig {
  subject: Subject;
  instruction: string;
}