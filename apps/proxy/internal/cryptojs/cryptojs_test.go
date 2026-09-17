package cryptojs

import (
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"strings"
	"testing"
)

func TestHashString(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"empty", "", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"},
		{"abc", "abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"},
		{"utf8", "pässword🔐", "cf8c5b2637586d33716ec70087482401e09f2fcfbdb24ccc581f4175a2c842fe"},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := HashString(tc.in); got != tc.want {
				t.Fatalf("HashString(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestEncryptDecryptRoundTrip(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name       string
		passphrase string
		plaintext  string
	}{
		{"ascii", "my passphrase", "The quick brown fox jumps over the lazy dog"},
		{"empty plaintext", "hunter2", ""},
		{"empty passphrase", "", "no key material"},
		{"block boundary", "secret", strings.Repeat("a", 16)},
		{"block boundary minus one", "secret", strings.Repeat("a", 15)},
		{"block boundary plus one", "secret", strings.Repeat("a", 17)},
		{"multibyte utf8", "пароль-密码", "emoji 🔐 unicode ✓"},
		{"json payload", "pass", `{"email":"user@example.com","refresh_token":"rt_123"}`},
		{"large", "pass", strings.Repeat("opendum", 5000)},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			encrypted, err := Encrypt(tc.passphrase, tc.plaintext)
			if err != nil {
				t.Fatalf("Encrypt: %v", err)
			}
			got, err := Decrypt(tc.passphrase, encrypted)
			if err != nil {
				t.Fatalf("Decrypt: %v", err)
			}
			if got != tc.plaintext {
				t.Fatalf("round trip = %q, want %q", got, tc.plaintext)
			}
		})
	}
}

func TestEncryptUsesFreshRandomSalt(t *testing.T) {
	t.Parallel()
	seen := map[string]struct{}{}
	for i := 0; i < 64; i++ {
		encrypted, err := Encrypt("pass", "same plaintext")
		if err != nil {
			t.Fatalf("Encrypt: %v", err)
		}
		if _, ok := seen[encrypted]; ok {
			t.Fatalf("duplicate ciphertext after %d iterations: %s", i, encrypted)
		}
		seen[encrypted] = struct{}{}
	}
}

func TestDecryptKnownVectors(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name       string
		passphrase string
		ciphertext string
		want       string
	}{
		{
			name:       "openssl compatible fox",
			passphrase: "my passphrase",
			ciphertext: "U2FsdGVkX18AAQIDBAUGByPoomCIY/Hhu7GRy4TtUpBFgAEpc2KRktdWKn1QJ7SHOSdc9SDtajmTK+Vgw6dxjw==",
			want:       "The quick brown fox jumps over the lazy dog",
		},
		{
			name:       "empty plaintext",
			passphrase: "hunter2",
			ciphertext: "U2FsdGVkX1+qu8zd7v8AEVb9is39Ntgq6LGDnki/bCs=",
			want:       "",
		},
		{
			name:       "multibyte utf8",
			passphrase: "пароль-密码",
			ciphertext: "U2FsdGVkX1/erb7vyv66vrB1E6bMrO4BXK72el1j6KhnSej23jZ32GnTaFITog01",
			want:       "emoji 🔐 unicode ✓",
		},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got, err := Decrypt(tc.passphrase, tc.ciphertext)
			if err != nil {
				t.Fatalf("Decrypt: %v", err)
			}
			if got != tc.want {
				t.Fatalf("Decrypt = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestEncryptProducesOpenSSLFormat(t *testing.T) {
	t.Parallel()
	encrypted, err := Encrypt("pass", "payload")
	if err != nil {
		t.Fatalf("Encrypt: %v", err)
	}
	if !strings.HasPrefix(encrypted, "U2FsdGVkX1") {
		t.Fatalf("ciphertext %q does not start with base64 of Salted__", encrypted)
	}
	raw, err := base64.StdEncoding.DecodeString(encrypted)
	if err != nil {
		t.Fatalf("base64: %v", err)
	}
	if string(raw[:8]) != "Salted__" {
		t.Fatalf("header = %q, want Salted__", raw[:8])
	}
	if len(raw) < 8+8+aes.BlockSize {
		t.Fatalf("raw length = %d, want header+salt+at least one block", len(raw))
	}
	if (len(raw)-16)%aes.BlockSize != 0 {
		t.Fatalf("ciphertext body length = %d, not a multiple of block size", len(raw)-16)
	}
}

func TestDecryptRejectsMalformedInput(t *testing.T) {
	t.Parallel()
	valid, err := Encrypt("pass", "payload")
	if err != nil {
		t.Fatalf("Encrypt: %v", err)
	}
	raw, err := base64.StdEncoding.DecodeString(valid)
	if err != nil {
		t.Fatalf("base64: %v", err)
	}
	cases := []struct {
		name       string
		ciphertext string
	}{
		{"invalid base64", "not base64!!"},
		{"empty", ""},
		{"shorter than header", base64.StdEncoding.EncodeToString([]byte("Salted__"))},
		{"missing magic header", base64.StdEncoding.EncodeToString(raw[8:])},
		{"truncated ciphertext", base64.StdEncoding.EncodeToString(raw[:len(raw)-1])},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if _, err := Decrypt("pass", tc.ciphertext); err == nil {
				t.Fatalf("Decrypt(%q) error = nil, want error", tc.ciphertext)
			}
		})
	}
}

func TestDecryptRejectsInvalidPadding(t *testing.T) {
	t.Parallel()
	const (
		passphrase = "pass"
		salt       = "\x00\x01\x02\x03\x04\x05\x06\x07"
	)
	cases := []struct {
		name  string
		block [aes.BlockSize]byte
	}{
		{name: "zero padding byte", block: [aes.BlockSize]byte{}},
		{name: "padding larger than block", block: func() [aes.BlockSize]byte {
			var b [aes.BlockSize]byte
			b[aes.BlockSize-1] = 0x11
			return b
		}()},
		{name: "inconsistent padding bytes", block: func() [aes.BlockSize]byte {
			var b [aes.BlockSize]byte
			b[aes.BlockSize-1] = 0x03
			return b
		}()},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			ciphertext := sealRawBlock(t, passphrase, []byte(salt), tc.block[:])
			if _, err := Decrypt(passphrase, ciphertext); err == nil {
				t.Fatalf("Decrypt error = nil, want padding error")
			}
		})
	}
}

func TestEvpBytesToKeyMatchesPublishedVector(t *testing.T) {
	t.Parallel()
	key, iv := evpBytesToKey([]byte("mypassword"), []byte("\xca\x35\x16\x8e\xd6\xb8\x27\x78"), 32, aes.BlockSize)
	if got := toHex(key); got != "844a86d27d96acf3147aa460f535e20e989d1f8b5d79c0403b4a0f34cebb093b" {
		t.Fatalf("key = %s, want 844a86d2...093b", got)
	}
	if got := toHex(iv); got != "aab7d6aca0cc6ffc18f9f5909753aa5f" {
		t.Fatalf("iv = %s, want aab7d6ac...aa5f", got)
	}
}

func TestPkcs7Pad(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name    string
		in      string
		padding int
	}{
		{"empty pads full block", "", 16},
		{"short pads remainder", "abc", 13},
		{"exact block pads full block", strings.Repeat("x", 16), 16},
		{"partial block", strings.Repeat("x", 17), 15},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			padded := pkcs7Pad([]byte(tc.in), aes.BlockSize)
			if len(padded)%aes.BlockSize != 0 {
				t.Fatalf("padded length = %d, not block aligned", len(padded))
			}
			if len(padded) != len(tc.in)+tc.padding {
				t.Fatalf("padded length = %d, want %d", len(padded), len(tc.in)+tc.padding)
			}
			for i := len(tc.in); i < len(padded); i++ {
				if int(padded[i]) != tc.padding {
					t.Fatalf("padding byte[%d] = %d, want %d", i, padded[i], tc.padding)
				}
			}
			unpadded, err := pkcs7Unpad(padded, aes.BlockSize)
			if err != nil {
				t.Fatalf("pkcs7Unpad: %v", err)
			}
			if string(unpadded) != tc.in {
				t.Fatalf("unpadded = %q, want %q", unpadded, tc.in)
			}
		})
	}
}

func TestPkcs7UnpadRejectsInvalidData(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name      string
		data      []byte
		blockSize int
	}{
		{"empty", nil, aes.BlockSize},
		{"not block aligned", []byte{1, 2, 3}, aes.BlockSize},
		{"zero padding", append(make([]byte, 15), 0), aes.BlockSize},
		{"padding exceeds block", append(make([]byte, 15), 17), aes.BlockSize},
		{"padding exceeds length", []byte{5}, 16},
		{"inconsistent bytes", append(make([]byte, 13), 3, 2), aes.BlockSize},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if _, err := pkcs7Unpad(tc.data, tc.blockSize); err == nil {
				t.Fatalf("pkcs7Unpad(%v, %d) error = nil, want error", tc.data, tc.blockSize)
			}
		})
	}
}

func FuzzEncryptDecryptRoundTrip(f *testing.F) {
	f.Add("passphrase", "plaintext")
	f.Add("", "")
	f.Add("пароль", "🔐 emoji")
	for _, seed := range []string{"", "a", strings.Repeat("x", 16), strings.Repeat("y", 4096)} {
		f.Add("key", seed)
	}
	f.Fuzz(func(t *testing.T, passphrase, plaintext string) {
		if len(passphrase) > 1<<12 || len(plaintext) > 1<<16 {
			return
		}
		encrypted, err := Encrypt(passphrase, plaintext)
		if err != nil {
			t.Fatalf("Encrypt: %v", err)
		}
		got, err := Decrypt(passphrase, encrypted)
		if err != nil {
			t.Fatalf("Decrypt: %v", err)
		}
		if got != plaintext {
			t.Fatalf("round trip = %q, want %q", got, plaintext)
		}
	})
}

func FuzzDecryptNeverPanics(f *testing.F) {
	f.Add("pass", "U2FsdGVkX18AAQIDBAUGByPoomCIY/Hhu7GRy4TtUpBFgAEpc2KRktdWKn1QJ7SHOSdc9SDtajmTK+Vgw6dxjw==")
	f.Add("pass", "not base64!!")
	f.Add("pass", "")
	f.Fuzz(func(t *testing.T, passphrase, ciphertext string) {
		_, _ = Decrypt(passphrase, ciphertext)
	})
}

func sealRawBlock(t *testing.T, passphrase string, salt, block []byte) string {
	t.Helper()
	key, iv := evpBytesToKey([]byte(passphrase), salt, 32, aes.BlockSize)
	c, err := aes.NewCipher(key)
	if err != nil {
		t.Fatalf("aes.NewCipher: %v", err)
	}
	sealed := make([]byte, len(block))
	cipher.NewCBCEncrypter(c, iv).CryptBlocks(sealed, block)
	raw := make([]byte, 0, 8+len(salt)+len(sealed))
	raw = append(raw, opensslSaltHeader...)
	raw = append(raw, salt...)
	raw = append(raw, sealed...)
	return base64.StdEncoding.EncodeToString(raw)
}

func toHex(data []byte) string {
	const hexdigits = "0123456789abcdef"
	out := make([]byte, 0, len(data)*2)
	for _, b := range data {
		out = append(out, hexdigits[b>>4], hexdigits[b&0x0f])
	}
	return string(out)
}
