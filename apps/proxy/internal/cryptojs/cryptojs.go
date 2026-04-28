package cryptojs

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/md5"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
)

var opensslSaltHeader = []byte("Salted__")

func HashString(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

func Decrypt(passphrase, ciphertext string) (string, error) {
	raw, err := base64.StdEncoding.DecodeString(ciphertext)
	if err != nil {
		return "", err
	}
	if len(raw) < len(opensslSaltHeader)+8 || !bytes.Equal(raw[:len(opensslSaltHeader)], opensslSaltHeader) {
		return "", errors.New("unsupported CryptoJS ciphertext format")
	}

	salt := raw[len(opensslSaltHeader) : len(opensslSaltHeader)+8]
	ciphertextBytes := raw[len(opensslSaltHeader)+8:]
	key, iv := evpBytesToKey([]byte(passphrase), salt, 32, aes.BlockSize)

	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	if len(ciphertextBytes) == 0 || len(ciphertextBytes)%aes.BlockSize != 0 {
		return "", errors.New("invalid AES-CBC ciphertext length")
	}

	plaintext := make([]byte, len(ciphertextBytes))
	cipher.NewCBCDecrypter(block, iv).CryptBlocks(plaintext, ciphertextBytes)

	unpadded, err := pkcs7Unpad(plaintext, aes.BlockSize)
	if err != nil {
		return "", err
	}
	return string(unpadded), nil
}

func evpBytesToKey(password, salt []byte, keyLen, ivLen int) ([]byte, []byte) {
	needed := keyLen + ivLen
	derived := make([]byte, 0, needed)
	previous := []byte{}

	for len(derived) < needed {
		h := md5.New()
		h.Write(previous)
		h.Write(password)
		h.Write(salt)
		previous = h.Sum(nil)
		derived = append(derived, previous...)
	}

	return derived[:keyLen], derived[keyLen:needed]
}

func pkcs7Unpad(data []byte, blockSize int) ([]byte, error) {
	if len(data) == 0 || len(data)%blockSize != 0 {
		return nil, errors.New("invalid PKCS7 data")
	}
	padding := int(data[len(data)-1])
	if padding == 0 || padding > blockSize || padding > len(data) {
		return nil, errors.New("invalid PKCS7 padding")
	}
	for _, b := range data[len(data)-padding:] {
		if int(b) != padding {
			return nil, errors.New("invalid PKCS7 padding bytes")
		}
	}
	return data[:len(data)-padding], nil
}
