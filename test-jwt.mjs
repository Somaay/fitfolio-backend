import { SignJWT } from 'jose';

async function test() {
  const secret = new TextEncoder().encode(process.env.SUPABASE_JWT_SECRET);
  const jwt = await new SignJWT({ sub: '12345678-1234-1234-1234-123456789012', iss: 'supabase' })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h')
    .sign(secret);

  console.log('Generated JWT:', jwt);

  const res = await fetch('http://127.0.0.1:8080/v1/me', {
    headers: { Authorization: `Bearer ${jwt}` }
  });

  console.log('Status:', res.status);
  console.log('Body:', await res.text());
}

test();
