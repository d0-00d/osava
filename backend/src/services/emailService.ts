export class HIBPError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function checkEmailBreaches(email: string) {
  const encodedEmail = encodeURIComponent(email);
  const response = await fetch(
    `https://haveibeenpwned.com/api/v3/breachedaccount/${encodedEmail}`,
    {
      headers: {
        "hibp-api-key": process.env.HIBP_API_KEY || "",
        "user-agent": "osava",
      },
    }
  );

  if (response.status === 404) {
    return { breached: false };
  }
  
  if (!response.ok) {
    const errorBody = await response.text();
    throw new HIBPError(response.status, `HIBP returned ${response.status}: ${errorBody}`);
  }
  
  const data = await response.json();
  return { breached: true, breaches: data };
}
