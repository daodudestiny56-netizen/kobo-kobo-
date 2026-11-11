# Kobo Kobo voice scripts: native-speaker review sheet

Generated 2026-11-10 08:58 UTC. Sample amounts: balance 36,800; today's sales 38,000; saved 760.

## How to review

1. Read each **spoken text** aloud as a trader would hear it on the phone.
2. Check: correct language, natural wording, correct spelling and tone marks / dots (Yoruba and Igbo).
3. Amounts are spoken in **English number words** on purpose (Nigerians usually say money in English).
   Tell us if a language should use its own number words instead.
4. The words **yes** (and the on-screen **YES**) must stay English: the SMS handler reads YES.
5. Write the corrected sentence in the last column. When a language is fully reviewed, change its `status` to
   `approved` in `voice_templates.json` (only a native speaker should do that).

Status now: **en** = approved, **pidgin** = draft, **yoruba** = draft, **hausa** = draft, **igbo** = draft

## ivr_welcome / default

| Language | Spoken text | Correction |
|---|---|---|
| English (approved) | Hello, this is Kobo Kobo, your pension helper. Press one to hear your balance. Press two to hear what we saved today. Press nine to hear this again. | |
| Nigerian Pidgin (draft) | Hello, na Kobo Kobo, your pension helper. Press one make you hear your balance. Press two make you hear wetin we save today. Press nine make you hear this one again. | |
| Yoruba (draft) | Báwo ni, èyí ni Kobo Kobo, olùrànlọ́wọ́ owó ìfẹ̀yìntì yín. Ẹ tẹ ọ̀kan láti gbọ́ iye owó yín. Ẹ tẹ èjì láti gbọ́ ohun tí a fi pamọ́ lónìí. Ẹ tẹ ẹ̀sán láti gbọ́ èyí lẹ́ẹ̀kan sí i. | |
| Hausa (draft) | Sannu, wannan Kobo Kobo ne, mataimakin fansho naku. Ku danna daya don jin ma'aunin kuɗinku. Ku danna biyu don jin abin da muka ajiye yau. Ku danna tara don sake jin wannan. | |
| Igbo (draft) | Ndewo, nke a bụ Kobo Kobo, onye inyeaka ụgwọ ezumike nka gị. Pịa otu ka ị nụrụ ego ị nwere. Pịa abụọ ka ị nụrụ ihe anyị chekwara taa. Pịa itoolu ka ị nụrụ nke a ọzọ. | |

## ivr_invalid / default

| Language | Spoken text | Correction |
|---|---|---|
| English (approved) | Sorry, we did not get that. | |
| Nigerian Pidgin (draft) | Sorry, we no understand wetin you press. | |
| Yoruba (draft) | Ẹ jọ̀wọ́, a kò gbọ́ ohun tí ẹ tẹ. | |
| Hausa (draft) | Yi hakuri, ba mu fahimci abin da kuka danna ba. | |
| Igbo (draft) | Biko gbaghara, anyị aghọtaghị ihe ị pịrị. | |

## ivr_goodbye / default

| Language | Spoken text | Correction |
|---|---|---|
| English (approved) | Thank you for saving with Kobo Kobo. Goodbye. | |
| Nigerian Pidgin (draft) | Thank you say you dey save with Kobo Kobo. Bye bye. | |
| Yoruba (draft) | Ẹ ṣeun tí ẹ ń fi owó pamọ́ pẹ̀lú Kobo Kobo. Ó dìgbà. | |
| Hausa (draft) | Mun gode da ajiya tare da Kobo Kobo. Sai an jima. | |
| Igbo (draft) | Daalụ maka ichekwa ego gị na Kobo Kobo. Ka ọ dị. | |

## ivr_unknown / default

| Language | Spoken text | Correction |
|---|---|---|
| English (approved) | Sorry, we could not find your account. Please dial the Kobo Kobo code to register. Goodbye. | |
| Nigerian Pidgin (draft) | Sorry, we no see your account. Abeg dial the Kobo Kobo code make you register. Bye bye. | |
| Yoruba (draft) | Ẹ jọ̀wọ́, a kò rí àkántì yín. Ẹ pe kóòdù Kobo Kobo láti forúkọ sílẹ̀. Ó dìgbà. | |
| Hausa (draft) | Yi hakuri, ba mu sami asusunku ba. Don Allah ku danna lambar Kobo Kobo don yin rajista. Sai an jima. | |
| Igbo (draft) | Biko gbaghara, anyị ahụghị akaụntụ gị. Biko pịa koodu Kobo Kobo ka ịdebanye aha. Ka ọ dị. | |

## ivr_not_ready / default

| Language | Spoken text | Correction |
|---|---|---|
| English (approved) | Your latest figures are not ready yet. Please try again later. Goodbye. | |
| Nigerian Pidgin (draft) | Your latest figures never ready yet. Abeg try again later. Bye bye. | |
| Yoruba (draft) | Àwọn ìṣirò yín tuntun kò tíì parí. Ẹ jọ̀wọ́ ẹ tún gbìyànjú lẹ́yìn náà. Ó dìgbà. | |
| Hausa (draft) | Sabbin alkaluman ku ba su kammala ba tukuna. Don Allah ku sake gwadawa daga baya. Sai an jima. | |
| Igbo (draft) | Ọnụ ọgụgụ gị kacha ọhụrụ adịbeghị njikere. Biko nwaa ọzọ mgbe e mesịrị. Ka ọ dị. | |

## ivr_outbound_only / default

| Language | Spoken text | Correction |
|---|---|---|
| English (approved) | For your safety, Kobo Kobo reads your balance only when we call you. Please dial the Kobo Kobo code and ask for a call. Goodbye. | |
| Nigerian Pidgin (draft) | For your safety, Kobo Kobo dey read your balance only when we call you. Abeg dial the Kobo Kobo code make you ask for call. Bye bye. | |
| Yoruba (draft) | Fún ààbò yín, Kobo Kobo ń ka iye owó yín nígbà tí a bá pè yín nìkan. Ẹ pe kóòdù Kobo Kobo kí ẹ bèèrè fún ìpè. Ó dìgbà. | |
| Hausa (draft) | Don tsaron ku, Kobo Kobo yana karanta ma'aunin kuɗinku ne kawai idan mun kira ku. Don Allah ku danna lambar Kobo Kobo ku nemi kira. Sai an jima. | |
| Igbo (draft) | Maka nchekwa gị, Kobo Kobo na-agụ ego ị nwere naanị mgbe anyị kpọrọ gị. Biko pịa koodu Kobo Kobo ma rịọ ka anyị kpọọ gị. Ka ọ dị. | |

## balance / eligible

| Language | Spoken text | Correction |
|---|---|---|
| English (approved) | Ngozi, Your total pension savings is thirty six thousand eight hundred naira. Your emergency pot has eighteen thousand four hundred naira. Your retirement pot has eighteen thousand four hundred naira. You can withdraw from your emergency pot now. Your retirement pot stays locked until you are fifty. Well done. | |
| Nigerian Pidgin (draft) | Ngozi, Your total pension money na thirty six thousand eight hundred naira. For emergency pot, eighteen thousand four hundred naira dey. For retirement pot, eighteen thousand four hundred naira dey. You fit withdraw from your emergency pot now. Your retirement pot go stay locked till you reach fifty years. Well done! | |
| Yoruba (draft) | Ngozi, Àpapọ̀ owó ìfẹ̀yìntì yín jẹ́ thirty six thousand eight hundred naira. Owó pàjáwìrì yín jẹ́ eighteen thousand four hundred naira. Owó ìfẹ̀yìntì yín jẹ́ eighteen thousand four hundred naira. Ẹ lè yọ owó pàjáwìrì yín báyìí. Owó ìfẹ̀yìntì yóò wà ní títì títí ẹ ó fi pé àádọ́ta ọdún. Ẹ ṣeun. | |
| Hausa (draft) | Ngozi, Jimillar kuɗin fansho naku shi ne thirty six thousand eight hundred naira. Asusun gaggawa yana da eighteen thousand four hundred naira. Asusun ritaya yana da eighteen thousand four hundred naira. Kuna iya cire kuɗin gaggawa yanzu. Za a rufe asusun ritaya har sai kun kai shekara hamsin. Mun gode. | |
| Igbo (draft) | Ngozi, Ngụkọta ego ezumike nka gị bụ thirty six thousand eight hundred naira. Ego mberede gị bụ eighteen thousand four hundred naira. Ego ezumike nka gị bụ eighteen thousand four hundred naira. Ị nwere ike iwepụ ego mberede gị ugbu a. A ga-akpọchi ego ezumike nka gị ruo mgbe ị ga-erue afọ iri ise. Daalụ. | |

## balance / waiting

| Language | Spoken text | Correction |
|---|---|---|
| English (approved) | Ngozi, Your total pension savings is thirty six thousand eight hundred naira. Your emergency pot has eighteen thousand four hundred naira. Your retirement pot has eighteen thousand four hundred naira. You can withdraw from your emergency pot in twelve days. Your retirement pot stays locked until you are fifty. Well done. | |
| Nigerian Pidgin (draft) | Ngozi, Your total pension money na thirty six thousand eight hundred naira. For emergency pot, eighteen thousand four hundred naira dey. For retirement pot, eighteen thousand four hundred naira dey. You go fit withdraw from your emergency pot after twelve days. Your retirement pot go stay locked till you reach fifty years. Well done! | |
| Yoruba (draft) | Ngozi, Àpapọ̀ owó ìfẹ̀yìntì yín jẹ́ thirty six thousand eight hundred naira. Owó pàjáwìrì yín jẹ́ eighteen thousand four hundred naira. Owó ìfẹ̀yìntì yín jẹ́ eighteen thousand four hundred naira. Ẹ ó lè yọ owó pàjáwìrì yín lẹ́yìn twelve days. Owó ìfẹ̀yìntì yóò wà ní títì títí ẹ ó fi pé àádọ́ta ọdún. Ẹ ṣeun. | |
| Hausa (draft) | Ngozi, Jimillar kuɗin fansho naku shi ne thirty six thousand eight hundred naira. Asusun gaggawa yana da eighteen thousand four hundred naira. Asusun ritaya yana da eighteen thousand four hundred naira. Za ku iya cire kuɗin gaggawa bayan twelve days. Za a rufe asusun ritaya har sai kun kai shekara hamsin. Mun gode. | |
| Igbo (draft) | Ngozi, Ngụkọta ego ezumike nka gị bụ thirty six thousand eight hundred naira. Ego mberede gị bụ eighteen thousand four hundred naira. Ego ezumike nka gị bụ eighteen thousand four hundred naira. Ị ga-enwe ike iwepụ ego mberede gị mgbe twelve days gachara. A ga-akpọchi ego ezumike nka gị ruo mgbe ị ga-erue afọ iri ise. Daalụ. | |

## balance / cooling

| Language | Spoken text | Correction |
|---|---|---|
| English (approved) | Ngozi, Your total pension savings is thirty six thousand eight hundred naira. Your emergency pot has eighteen thousand four hundred naira. Your retirement pot has eighteen thousand four hundred naira. You can make your next emergency withdrawal in twenty days. Your retirement pot stays locked until you are fifty. Well done. | |
| Nigerian Pidgin (draft) | Ngozi, Your total pension money na thirty six thousand eight hundred naira. For emergency pot, eighteen thousand four hundred naira dey. For retirement pot, eighteen thousand four hundred naira dey. You fit make another emergency withdrawal after twenty days. Your retirement pot go stay locked till you reach fifty years. Well done! | |
| Yoruba (draft) | Ngozi, Àpapọ̀ owó ìfẹ̀yìntì yín jẹ́ thirty six thousand eight hundred naira. Owó pàjáwìrì yín jẹ́ eighteen thousand four hundred naira. Owó ìfẹ̀yìntì yín jẹ́ eighteen thousand four hundred naira. Ẹ lè tún yọ owó pàjáwìrì lẹ́yìn twenty days. Owó ìfẹ̀yìntì yóò wà ní títì títí ẹ ó fi pé àádọ́ta ọdún. Ẹ ṣeun. | |
| Hausa (draft) | Ngozi, Jimillar kuɗin fansho naku shi ne thirty six thousand eight hundred naira. Asusun gaggawa yana da eighteen thousand four hundred naira. Asusun ritaya yana da eighteen thousand four hundred naira. Za ku iya sake cire kuɗin gaggawa bayan twenty days. Za a rufe asusun ritaya har sai kun kai shekara hamsin. Mun gode. | |
| Igbo (draft) | Ngozi, Ngụkọta ego ezumike nka gị bụ thirty six thousand eight hundred naira. Ego mberede gị bụ eighteen thousand four hundred naira. Ego ezumike nka gị bụ eighteen thousand four hundred naira. Ị nwere ike iwepụ ego mberede ọzọ mgbe twenty days gachara. A ga-akpọchi ego ezumike nka gị ruo mgbe ị ga-erue afọ iri ise. Daalụ. | |

## balance / empty

| Language | Spoken text | Correction |
|---|---|---|
| English (approved) | Ngozi, You have not saved anything yet. Your first savings will come from your next sales. | |
| Nigerian Pidgin (draft) | Ngozi, You never save anything yet. Your first savings go come from your next sales. | |
| Yoruba (draft) | Ngozi, Ẹ kò tíì fi nǹkan kan pamọ́. Ìfipamọ́ àkọ́kọ́ yín yóò wá láti ara ọjà yín tó kàn. | |
| Hausa (draft) | Ngozi, Ba ku riga kun ajiye komai ba. Ajiyarku ta farko za ta fito daga sayarwarku ta gaba. | |
| Igbo (draft) | Ngozi, Ịchekwabeghị ihe ọ bụla. Nchekwa mbụ gị ga-esite n'ahịa gị na-esote. | |

## sweep_receipt / normal

| Language | Spoken text | Correction |
|---|---|---|
| English (approved) | Ngozi, Today you sold thirty eight thousand naira. We saved seven hundred and sixty naira for your pension. eighteen thousand four hundred naira went to your emergency pot and eighteen thousand four hundred naira to your retirement pot. We also found one big payment of ten million naira and did not save from it yet. Please check your text messages. Well done. | |
| Nigerian Pidgin (draft) | Ngozi, Today you sell thirty eight thousand naira. We save seven hundred and sixty naira for your pension. eighteen thousand four hundred naira enter emergency pot, eighteen thousand four hundred naira enter retirement pot. We also see one big payment, ten million naira. We never save from am yet. Check your text message. Well done! | |
| Yoruba (draft) | Ngozi, Ọjà tí ẹ tà lónìí jẹ́ thirty eight thousand naira. A fi seven hundred and sixty naira pamọ́ fún owó ìfẹ̀yìntì yín. eighteen thousand four hundred naira lọ sínú owó pàjáwìrì, eighteen thousand four hundred naira sì lọ sínú owó ìfẹ̀yìntì. A tún rí owó ńlá kan, ten million naira. A kò tíì fi pamọ́ nínú rẹ̀. Ẹ jọ̀wọ́ ẹ wo ìfiránṣẹ́ orí fóònù yín. Ẹ ṣeun. | |
| Hausa (draft) | Ngozi, Yau kun sayar da kaya na thirty eight thousand naira. Mun ajiye seven hundred and sixty naira don fansho naku. eighteen thousand four hundred naira ya shiga asusun gaggawa, eighteen thousand four hundred naira kuma ya shiga na ritaya. Mun kuma ga babban kuɗi guda, ten million naira. Ba mu ajiye daga ciki ba tukuna. Don Allah ku duba saƙon wayarku. Mun gode. | |
| Igbo (draft) | Ngozi, Taa, ire ahịa gị bụ thirty eight thousand naira. Anyị chekwara seven hundred and sixty naira maka ụgwọ ezumike nka gị. eighteen thousand four hundred naira banyere n'ego mberede, eighteen thousand four hundred naira banyekwara n'ego ezumike nka. Anyị hụkwara nnukwu ego otu, ten million naira. Anyị achekwabeghị ya. Biko lelee ozi ekwentị gị. Daalụ. | |

## sweep_receipt / zero_sales

| Language | Spoken text | Correction |
|---|---|---|
| English (approved) | Ngozi, No sales today, so we saved nothing. No problem. See you tomorrow. We also found one big payment of ten million naira and did not save from it yet. Please check your text messages. | |
| Nigerian Pidgin (draft) | Ngozi, No sales today, so we no save anything. No wahala. We go see tomorrow. We also see one big payment, ten million naira. We never save from am yet. Check your text message. | |
| Yoruba (draft) | Ngozi, Kò sí títà lónìí, nítorí náà a kò fi nǹkan pamọ́. Kò sí wàhálà. Ẹ ó rí wa lọ́la. A tún rí owó ńlá kan, ten million naira. A kò tíì fi pamọ́ nínú rẹ̀. Ẹ jọ̀wọ́ ẹ wo ìfiránṣẹ́ orí fóònù yín. | |
| Hausa (draft) | Ngozi, Babu sayarwa yau, don haka ba mu ajiye komai ba. Babu damuwa. Sai gobe. Mun kuma ga babban kuɗi guda, ten million naira. Ba mu ajiye daga ciki ba tukuna. Don Allah ku duba saƙon wayarku. | |
| Igbo (draft) | Ngozi, Enweghị ahịa taa, ya mere anyị echekwaghị ihe ọ bụla. Enweghị nsogbu. Ka ọ dị echi. Anyị hụkwara nnukwu ego otu, ten million naira. Anyị achekwabeghị ya. Biko lelee ozi ekwentị gị. | |

## sweep_receipt / no_sweep

| Language | Spoken text | Correction |
|---|---|---|
| English (approved) | Ngozi, Today you sold thirty eight thousand naira, but we did not save anything tonight. Saving continues with your next sales. | |
| Nigerian Pidgin (draft) | Ngozi, Today you sell thirty eight thousand naira, but we no save anything tonight. Saving go continue with your next sales. | |
| Yoruba (draft) | Ngozi, Ọjà tí ẹ tà lónìí jẹ́ thirty eight thousand naira, ṣùgbọ́n a kò fi nǹkan pamọ́ lálẹ́ yìí. Ìfipamọ́ yóò tẹ̀síwájú pẹ̀lú ọjà yín tó kàn. | |
| Hausa (draft) | Ngozi, Yau kun sayar da kaya na thirty eight thousand naira, amma ba mu ajiye komai ba a daren nan. Ajiya za ta ci gaba da sayarwarku ta gaba. | |
| Igbo (draft) | Ngozi, Taa, ire ahịa gị bụ thirty eight thousand naira, ma anyị echekwaghị ihe ọ bụla n'abalị a. Nchekwa ga-aga n'ihu site n'ahịa gị na-esote. | |

## sweep_receipt / low_balance

| Language | Spoken text | Correction |
|---|---|---|
| English (approved) | Ngozi, Today you sold thirty eight thousand naira, but we saved nothing so that your account keeps a small balance for you. Saving continues with your next sales. | |
| Nigerian Pidgin (draft) | Ngozi, Today you sell thirty eight thousand naira, but we no save anything so that small money go remain for your account. Saving go continue with your next sales. | |
| Yoruba (draft) | Ngozi, Ọjà tí ẹ tà lónìí jẹ́ thirty eight thousand naira, ṣùgbọ́n a kò fi nǹkan pamọ́ kí owó díẹ̀ lè ṣẹ́kù nínú àkántì yín. Ìfipamọ́ yóò tẹ̀síwájú pẹ̀lú ọjà yín tó kàn. | |
| Hausa (draft) | Ngozi, Yau kun sayar da kaya na thirty eight thousand naira, amma ba mu ajiye komai ba don asusunku ya ci gaba da samun ɗan kuɗi. Ajiya za ta ci gaba da sayarwarku ta gaba. | |
| Igbo (draft) | Ngozi, Taa, ire ahịa gị bụ thirty eight thousand naira, ma anyị echekwaghị ihe ọ bụla ka obere ego fọdụrụ n'akaụntụ gị. Nchekwa ga-aga n'ihu site n'ahịa gị na-esote. | |

## sweep_receipt / paused

| Language | Spoken text | Correction |
|---|---|---|
| English (approved) | Ngozi, Your saving is paused, so nothing was saved today. To start again, send RESUME by text message. | |
| Nigerian Pidgin (draft) | Ngozi, Your saving don pause, so we no save anything today. To start again, send RESUME for text message. | |
| Yoruba (draft) | Ngozi, A ti dá ìfipamọ́ yín dúró, nítorí náà a kò fi nǹkan pamọ́ lónìí. Láti tún bẹ̀rẹ̀, ẹ fi RESUME ránṣẹ́ nípasẹ̀ ìfiránṣẹ́ orí fóònù. | |
| Hausa (draft) | Ngozi, An dakatar da ajiyarku, don haka ba mu ajiye komai ba yau. Don sake farawa, ku aika RESUME ta saƙon waya. | |
| Igbo (draft) | Ngozi, A kwụsịrị nchekwa gị, ya mere anyị echekwaghị ihe ọ bụla taa. Ka ịmalite ọzọ, zipu RESUME site n'ozi ekwentị. | |

## rate_suggestion / increase

| Language | Spoken text | Correction |
|---|---|---|
| English (approved) | Ngozi, Your sales have been steady. We suggest moving your pension saving from two percent to two point five percent. This adds about five thousand seven hundred naira every month. To agree, reply yes to the text message we sent. If you do nothing, your rate stays the same. | |
| Nigerian Pidgin (draft) | Ngozi, Your sales dey steady. We wan move your pension saving from two percent to two point five percent. E go add about five thousand seven hundred naira every month. If you agree, reply yes for the text message wey we send. If you no do anything, your rate go stay as e be. | |
| Yoruba (draft) | Ngozi, Títà yín ti dúró ṣinṣin. A dábàá pé kí a gbé ìfipamọ́ owó ìfẹ̀yìntì yín láti two percent sí two point five percent. Èyí yóò fi bí five thousand seven hundred naira kún un lóṣooṣù. Tí ẹ bá fọwọ́ sí i, ẹ fèsì yes sí ìfiránṣẹ́ tí a rán sí yín. Tí ẹ kò bá ṣe nǹkan kan, ìpín yín yóò wà bí ó ṣe wà. | |
| Hausa (draft) | Ngozi, Sayarwarku ta tsaya daram. Muna ba da shawarar mu ƙara ajiyar fansho naku daga two percent zuwa two point five percent. Wannan zai ƙara kusan five thousand seven hundred naira kowane wata. Idan kun yarda, ku amsa yes ga saƙon da muka aika. Idan ba ku yi komai ba, adadin ajiyarku zai tsaya yadda yake. | |
| Igbo (draft) | Ngozi, Ahịa gị na-aga nke ọma. Anyị na-atụ aro ka anyị bulie nchekwa ụgwọ ezumike nka gị site na two percent ruo two point five percent. Nke a ga-agbakwunye ihe dị ka five thousand seven hundred naira kwa ọnwa. Ọ bụrụ na ị kwenyere, zaa yes n'ozi anyị zitere. Ọ bụrụ na ị emeghị ihe ọ bụla, oke gị ga-anọgide ka ọ dị. | |

## rate_suggestion / decrease

| Language | Spoken text | Correction |
|---|---|---|
| English (approved) | Ngozi, Your sales have been uneven lately. To protect your business money, we suggest lowering your pension saving from two percent to two point five percent. This lowers your saving by about five thousand seven hundred naira every month. To agree, reply yes to the text message we sent. If you do nothing, your rate stays the same. | |
| Nigerian Pidgin (draft) | Ngozi, Your sales don dey up and down. To protect your business money, we wan reduce your pension saving from two percent to two point five percent. E go reduce your saving by about five thousand seven hundred naira every month. If you agree, reply yes for the text message wey we send. If you no do anything, your rate go stay as e be. | |
| Yoruba (draft) | Ngozi, Títà yín ti ń lọ sókè sódò láìpẹ́ yìí. Láti dáàbò bo owó iṣẹ́ yín, a dábàá pé kí a dín ìfipamọ́ owó ìfẹ̀yìntì yín kù láti two percent sí two point five percent. Èyí yóò dín ìfipamọ́ yín kù ní bí five thousand seven hundred naira lóṣooṣù. Tí ẹ bá fọwọ́ sí i, ẹ fèsì yes sí ìfiránṣẹ́ tí a rán sí yín. Tí ẹ kò bá ṣe nǹkan kan, ìpín yín yóò wà bí ó ṣe wà. | |
| Hausa (draft) | Ngozi, Sayarwarku ta yi sama da ƙasa kwanan nan. Don kare kuɗin kasuwancinku, muna ba da shawarar mu rage ajiyar fansho naku daga two percent zuwa two point five percent. Wannan zai rage ajiyarku da kusan five thousand seven hundred naira kowane wata. Idan kun yarda, ku amsa yes ga saƙon da muka aika. Idan ba ku yi komai ba, adadin ajiyarku zai tsaya yadda yake. | |
| Igbo (draft) | Ngozi, Ahịa gị adịghị ka ọ na-adị n'oge na-adịbeghị anya. Iji chebe ego azụmahịa gị, anyị na-atụ aro ka anyị belata nchekwa ụgwọ ezumike nka gị site na two percent ruo two point five percent. Nke a ga-ebelata nchekwa gị site na ihe dị ka five thousand seven hundred naira kwa ọnwa. Ọ bụrụ na ị kwenyere, zaa yes n'ozi anyị zitere. Ọ bụrụ na ị emeghị ihe ọ bụla, oke gị ga-anọgide ka ọ dị. | |
