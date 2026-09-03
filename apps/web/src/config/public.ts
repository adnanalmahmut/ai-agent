function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

export const publicConfig = {
  appName: required('NEXT_PUBLIC_APP_NAME', process.env.NEXT_PUBLIC_APP_NAME),
  apiUrl: required('NEXT_PUBLIC_API_URL', process.env.NEXT_PUBLIC_API_URL),
} as const;
