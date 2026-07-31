import { promisify } from "node:util";


export async function getkicomAvDownloadUrl(): Promise<string> {
    const response = await fetch("https://api.github.com/repos/hanul93/kicomav/releases/latest");
    if (!response.ok) {
        throw new Error(`Failed to fetch KicomAV release info: ${response.statusText}`);
    }
    const data = await response.json();

}