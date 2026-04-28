package db

import (
	"crypto/rand"
	"time"
)

const cuidAlphabet = "abcdefghijklmnopqrstuvwxyz0123456789"

func NewID() string {
	buf := make([]byte, 18)
	if _, err := rand.Read(buf); err != nil {
		return time.Now().UTC().Format("20060102150405.000000000")
	}
	out := make([]byte, 24)
	out[0] = 'c'
	for i := 1; i < len(out); i++ {
		out[i] = cuidAlphabet[int(buf[(i-1)%len(buf)])%len(cuidAlphabet)]
	}
	return string(out)
}
