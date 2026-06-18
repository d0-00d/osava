import {useState} from 'react';

export default function EmailCheck() {
    const [email, setEmail] = useState('');
    const [loading, setLoading] = useState(false);
    const [result, setResult] = useState<string | null>(null);
    return(
        <div>
            <h2>Email Breach Checker</h2>
            <input type="email" placeholder="Enter your email" value={email} onChange={e => setEmail(e.target.value)} />
            <button onClick={async () => {
                setResult(null);
                setLoading(true);
                try {
                    const response = await fetch(`http://localhost:4000/api/check-email/${encodeURIComponent(email)}`);
                    const data = await response.json();
                            if (data.error) {
                                setResult(`API Error: ${data.error}`);
                            }
                            else if (data.breached) {
                                setResult(`Your email has been breached in ${data.breaches.length} breaches.`);
                                const breachNames = data.breaches.map((breach: any) => breach.Name).join(", ");
                                setResult(prev => prev ? `${prev} Breach details: ${breachNames}` : `Your email has been breached in ${data.breaches.length} breaches. Breach details: ${breachNames}`);
                            }
                            else {
                                setResult("Good News! your email has not been breached.");
                            }
                }
                catch (error) {
                    setResult("Error checking email.");
                } finally {
                    setLoading(false);
                }            }} disabled={loading}>Check</button>
            {loading && <p>Checking...</p>}
            {result && <p>{result}</p>}
            
        </div>
    )};