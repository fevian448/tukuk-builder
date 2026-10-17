export interface UpdateCheckResult {
  available: boolean;
  version: string;
  releaseNotes?: string;
  error?: {
    type: 'rate_limit' | 'network' | 'auth' | 'unknown';
    message: string;
  };
}

interface PackageJson {
  version: string;
  name: string;
  [key: string]: unknown;
}

export const checkForUpdates = async (): Promise<UpdateCheckResult> => {
  try {
    // Get the current version from local package.json
    const packageResponse = await fetch('/package.json');

    if (!packageResponse.ok) {
      throw new Error('Failed to fetch local package.json');
    }

    const packageData = (await packageResponse.json()) as PackageJson;

    if (!packageData.version || typeof packageData.version !== 'string') {
      throw new Error('Invalid package.json format: missing or invalid version');
    }

    const currentVersion = packageData.version;

    /*
     * Fork Tukuk-OS: semakan kemas kini ke repositori bolt.diy asal
     * DIMATIKAN — tiada panggilan keluar ke stackblitz, dan pengguna
     * tidak pernah disuruh naik taraf ke versi hulu.
     */
    return { available: false, version: currentVersion };
  } catch (error) {
    console.error('Error checking for updates:', error);

    // Determine error type
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';

    const isNetworkError =
      errorMessage.toLowerCase().includes('network') || errorMessage.toLowerCase().includes('fetch');

    return {
      available: false,
      version: 'unknown',
      error: {
        type: isNetworkError ? 'network' : 'unknown',
        message: `Failed to check for updates: ${errorMessage}`,
      },
    };
  }
};

export const acknowledgeUpdate = async (version: string): Promise<void> => {
  // Store the acknowledged version in localStorage
  try {
    localStorage.setItem('last_acknowledged_update', version);
  } catch (error) {
    console.error('Failed to store acknowledged version:', error);
  }
};
