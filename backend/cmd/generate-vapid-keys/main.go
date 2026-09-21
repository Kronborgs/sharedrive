package main

import (
	"fmt"

	webpush "github.com/SherClockHolmes/webpush-go"
)

func main() {
	privateKey, publicKey, err := webpush.GenerateVAPIDKeys()
	if err != nil { panic(err) }
	fmt.Printf("WEB_PUSH_PUBLIC_KEY=%s\nWEB_PUSH_PRIVATE_KEY=%s\n", publicKey, privateKey)
}