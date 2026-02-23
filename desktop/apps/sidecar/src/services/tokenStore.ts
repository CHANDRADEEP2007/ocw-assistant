// Keychain-first token storage. Fallback storage can be added later if keytar is unavailable on a platform.
export async function setSecret(service: string, account: string, secret: string): Promise<boolean> {
  try {
    const keytar = await import('keytar');
    await keytar.default.setPassword(service, account, secret);
    return true;
  } catch {
    return false;
  }
}

export async function getSecret(service: string, account: string): Promise<string | null> {
  try {
    const keytar = await import('keytar');
    return (await keytar.default.getPassword(service, account)) ?? null;
  } catch {
    return null;
  }
}

export async function deleteSecret(service: string, account: string): Promise<boolean> {
  try {
    const keytar = await import('keytar');
    return await keytar.default.deletePassword(service, account);
  } catch {
    return false;
  }
}
