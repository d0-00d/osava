import { promisify } from "node:util";


export async function getkicomAvDownloadUrl(): Promise<string> {
    const response = await fetch("https://api.github.com/repos/hanul93/kicomav/releases/latest");
    if (!response.ok) {
        throw new Error(`Failed to fetch KicomAV release info: ${response.statusText}`);
    }
    const data = await response.json();
    void data;
    // Scaffold: nothing imports this yet. Failing loudly beats returning nothing from a function that
    // promises a URL (which is also what kept `tsc` from passing on the backend).
    throw new Error("KicomAV installation is not implemented yet");
}