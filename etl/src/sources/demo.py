"""Fonte de dados DEMO -- uma operacao logistica 100% sintetica.

Gera, sem rede e de forma DETERMINISTICA (mesma semente => mesmos dados),
uma rede fictícia (3 hubs, 12 centros de triagem, 72 bases de entrega) e o
fluxo de viagens, pacotes, indicadores, tickets e coletas em pontos parceiros
(PUDO) ao redor do relogio (`now`). Nada aqui vem de uma operacao real.

O estado de cada viagem e' calculado a partir da linha do tempo (lacre ->
partida -> deslacre -> chegada) comparada com `now`, entao rodar o ETL de
hora em hora faz a operacao "andar": viagens planejadas viram em transito,
depois descarregando, depois concluidas. Ha' de proposito:
  - pacotes que nunca sao descarregados (candidatos a "Expedido nao chegou");
  - pacotes que aparecem no descarregamento sem terem sido carregados pela
    viagem ("pacote voando"/reexpedicao);
  - viagens Secundarias com varias paradas sob o mesmo shipment_no.
"""
from __future__ import annotations

import hashlib
import random
from calendar import monthrange
from datetime import date, datetime, timedelta
from typing import Callable

from .. import config

ESTADOS = config.REGIAO_ESTADOS
_NOMES = ["Alder", "Birch", "Cedar", "Dogwood", "Elm", "Fir", "Ginkgo", "Hazel", "Iris", "Juniper",
          "Kauri", "Larch", "Maple", "Nettle", "Oak", "Pine", "Quince", "Rowan", "Spruce", "Tamarack",
          "Umber", "Vine", "Willow", "Yew", "Zelkova"]
_SUFIXOS = ["Vale", "Norte", "Sul", "Alto", "Novo", "Baixo", "Grande", "Verde"]
_UFS_DESTINO = ["PR", "SC", "RS", "SP", "RJ", "MG", "BA", "PE", "CE", "GO", "DF"]

# codigo -> nome da "origem do pedido" (C2C e PUDO)
_ORIGENS_C2C = {
    "S01": "Official Site", "S02": "Partner App", "S03": "Partner Web", "S04": "Official H5",
    "S05": "QR Code", "S06": "Branch Portal", "S07": "Courier App",
}
_MARKETPLACES = ["Marketplace A", "Marketplace B", "Marketplace C", "Marketplace D",
                 "Marketplace E", "Integrator X", "Integrator Y", "Carrier Hub"]
_STATUS_PUDO = [("已揽收", 0.82), ("已入库待揽收", 0.16), ("待支付", 0.008), ("待打印", 0.004), ("", 0.008)]
_PESO_HORA = [0.2, 0.1, 0.1, 0.1, 0.1, 0.2, 0.4, 0.8, 1.2, 1.6, 1.8, 2.2,
              2.6, 3.6, 5.0, 6.5, 8.0, 6.0, 3.0, 1.8, 0.9, 0.5, 0.3, 0.2]


def _rng(*partes) -> random.Random:
    return random.Random("|".join(str(p) for p in partes))


def _h(texto: str) -> int:
    return int(hashlib.md5(texto.encode()).hexdigest()[:8], 16)


def municipios_demo() -> list[dict]:
    """Municipios ficticios + prazos por hub (usado pela seed e pelo C2C)."""
    rng = _rng("municipios")
    vistos, saida = set(), []
    for uf in _UFS_DESTINO:
        for i in range(8):
            nome = f"{rng.choice(_NOMES)} {rng.choice(_SUFIXOS)}"
            if (nome, uf) in vistos:
                continue
            vistos.add((nome, uf))
            perto = uf in ESTADOS
            saida.append({
                "municipio": nome, "uf": uf,
                "prazo_hub1_dias": rng.randint(1, 3) if perto else rng.randint(3, 8),
                "prazo_hub2_dias": rng.randint(1, 3) if perto else rng.randint(3, 8),
                "prazo_hub3_dias": rng.randint(1, 3) if perto else rng.randint(3, 8),
            })
    return saida


class _Rede:
    def __init__(self):
        self.hubs = {uf: {"codigo": f"HUB{i + 1}", "nome": f"Hub {uf}", "uf": uf} for i, uf in enumerate(ESTADOS)}
        self.scs, self.dcs = [], []
        for uf in ESTADOS:
            for i in range(4):
                nome = _NOMES[(_h(uf) + i * 3) % len(_NOMES)]
                sc = {"codigo": f"SC{uf}{i + 1:02d}", "nome": f"SC {nome} - {uf}", "uf": uf}
                self.scs.append(sc)
                for j in range(6):
                    self.dcs.append({
                        "codigo": f"DC{uf}{i + 1:02d}{j + 1}",
                        "nome": f"DC {nome} {j + 1} - {uf}", "uf": uf, "sc": sc["codigo"],
                    })
        self.por_codigo = {b["codigo"]: b for b in [*self.hubs.values(), *self.scs, *self.dcs]}

    def dcs_do_sc(self, sc_codigo):
        return [d for d in self.dcs if d["sc"] == sc_codigo]


class DemoSource:
    name = "demo"

    def __init__(self, seed: int = 42, now: datetime | None = None, scale: float = 1.0):
        self.seed = seed
        self.now = (now or datetime.now()).replace(microsecond=0)
        self.scale = scale
        self.rede = _Rede()
        self._viagens_cache: list[dict] | None = None
        self._pacotes_cache: dict[str, dict] = {}

    # ===================================================== viagens e pernas
    def _viagens(self) -> list[dict]:
        if self._viagens_cache is not None:
            return self._viagens_cache
        hoje = self.now.date()
        viagens = []
        for delta in (-2, -1, 0, 1):
            d = hoje + timedelta(days=delta)
            rng = _rng(self.seed, "viagens", d)
            for i in range(14):
                uf = rng.choice(ESTADOS)
                hub = self.rede.hubs[uf]
                sc = rng.choice([s for s in self.rede.scs if s["uf"] == uf])
                origem, destino = (hub, sc) if rng.random() < 0.5 else (sc, hub)
                viagens.append(self._montar_viagem(
                    rng, d, f"{rng.choice(['DKGX', 'DBGX', 'DHGX'])}{d:%y%m%d}{i:05d}", "troncal",
                    origem, [destino], (90, 420), (600, 3200)))
            for i in range(40):
                sc = rng.choice(self.rede.scs)
                paradas = rng.sample(self.rede.dcs_do_sc(sc["codigo"]), rng.randint(2, 4))
                viagens.append(self._montar_viagem(
                    rng, d, f"{rng.choice(['SRTR', 'SETR'])}{d:%y%m%d}{i:05d}", "secundaria",
                    sc, paradas, (25, 110), (150, 1400)))
        self._viagens_cache = viagens
        return viagens

    def _montar_viagem(self, rng, d, shipment_no, tipo, origem, paradas, dur_min, carga):
        partida_plan = datetime(d.year, d.month, d.day, rng.randint(0, 23), rng.randint(0, 59))
        atraso = timedelta(minutes=rng.randint(0, 12))
        pernas = []
        anterior, chegada_anterior, plan_cursor = origem, None, partida_plan
        for j, parada in enumerate(paradas):
            dur = timedelta(minutes=rng.randint(*dur_min))
            saida = (partida_plan + atraso) if j == 0 else chegada_anterior + timedelta(minutes=rng.randint(10, 25))
            chegada = saida + dur
            deslacre = chegada + timedelta(minutes=rng.randint(2, 8))
            # ~8% das descargas sao LENTAS (5-8h): sao elas que deixam
            # pacotes sem bipe de chegada perto de estourar a janela de 6h.
            lenta = rng.random() < 0.08
            fim_desc = deslacre + timedelta(minutes=rng.randint(300, 480) if lenta else rng.randint(25, 100))
            pernas.append({
                "origem": anterior, "destino": parada,
                "lacre": saida - timedelta(minutes=15), "saida": saida, "chegada_veic": chegada,
                "deslacre": deslacre, "fim_descarga": fim_desc,
                "plan_saida": plan_cursor, "plan_chegada": plan_cursor + dur,
            })
            anterior, chegada_anterior, plan_cursor = parada, chegada, plan_cursor + dur + timedelta(minutes=15)
        return {
            "shipment_no": shipment_no, "tipo": tipo, "origem": origem, "paradas": paradas,
            "pernas": pernas, "n_carga": rng.randint(*carga),
            "placa": f"DEM{rng.randint(1000, 9999)}",
            "modelo": rng.choice(["Truck", "Van", "Carreta", "VUC"]),
            "transportador": f"Carrier {rng.choice('ABCDEF')}",
            "motorista": f"Driver {rng.randint(1, 60):02d}",
        }

    def _ate_agora(self, ts):
        return ts if ts <= self.now else None

    def _linha_perna(self, v, p):
        lacre, saida = self._ate_agora(p["lacre"]), self._ate_agora(p["saida"])
        deslacre = self._ate_agora(p["deslacre"])
        chegada = self._ate_agora(p["fim_descarga"])
        from ..common import utils
        prazo = deslacre + timedelta(hours=config.PRAZO_LIMITE_HORAS) if deslacre else None
        return {
            "shipment_no": v["shipment_no"], "tipo_perna": v["tipo"],
            "shipment_name": f"Route {v['shipment_no'][-5:]}",
            "base_origem_codigo": p["origem"]["codigo"], "base_origem_nome": p["origem"]["nome"],
            "base_destino_codigo": p["destino"]["codigo"], "base_destino_nome": p["destino"]["nome"],
            "placa": v["placa"], "modelo_veiculo": v["modelo"], "transportador": v["transportador"],
            "motorista": v["motorista"], "mileage": round(30 + (_h(v["shipment_no"]) % 400), 1),
            "hora_lacre": lacre, "hora_deslacre": deslacre,
            "planejado_partida": p["plan_saida"], "planejado_chegada": p["plan_chegada"],
            "partida_real": saida, "chegada_real": chegada,
            "shipment_state": 1 if chegada else 0,
            "etapa": utils.derivar_etapa(lacre, deslacre, saida, chegada),
            "prazo_limite": prazo,
        }

    def fetch_legs(self):
        troncais, secundarias = [], []
        for v in self._viagens():
            destino = troncais if v["tipo"] == "troncal" else secundarias
            destino.extend(self._linha_perna(v, p) for p in v["pernas"])
        return troncais, secundarias

    # ======================================================== pacotes/eventos
    def _pacotes(self, v) -> dict:
        """Todos os pacotes da viagem com linha do tempo, calculado 1x."""
        chave = v["shipment_no"]
        if chave in self._pacotes_cache:
            return self._pacotes_cache[chave]
        rng = _rng(self.seed, "pacotes", chave)
        n = v["n_carga"]
        pesos = [rng.random() + 0.3 for _ in v["paradas"]]
        total_peso = sum(pesos)
        prefixo = f"{_h(chave) % 10_000_000:07d}"
        primeira_saida = v["pernas"][0]["saida"]
        carregados, voando = [], []
        for i in range(n):
            j = rng.choices(range(len(v["paradas"])), weights=pesos)[0]
            perna = v["pernas"][j]
            duracao = (perna["fim_descarga"] - perna["deslacre"]).total_seconds()
            nunca_descarrega = rng.random() < 0.015
            unload = None if nunca_descarrega else perna["deslacre"] + timedelta(seconds=rng.random() * duracao)
            carregados.append({
                "bill_code": f"BR{prefixo}{i:05d}", "stop": j, "loaded_at": primeira_saida - timedelta(minutes=rng.randint(20, 180)),
                "unload_at": unload,
            })
        for i in range(max(1, int(n * 0.02))):
            j = rng.randrange(len(v["paradas"]))
            perna = v["pernas"][j]
            duracao = (perna["fim_descarga"] - perna["deslacre"]).total_seconds()
            voando.append({
                "bill_code": f"FLY{prefixo}{i:04d}", "stop": j,
                "unload_at": perna["deslacre"] + timedelta(seconds=rng.random() * duracao),
            })
        _ = total_peso
        self._pacotes_cache[chave] = {"carregados": carregados, "voando": voando}
        return self._pacotes_cache[chave]

    def _viagem(self, shipment_no):
        for v in self._viagens():
            if v["shipment_no"] == shipment_no:
                return v
        return None

    def fetch_scan_summary(self, shipment_nos, leg_type):
        resultado = {}
        for sn in shipment_nos:
            v = self._viagem(sn)
            if not v or v["tipo"] != leg_type or v["pernas"][0]["lacre"] > self.now:
                continue
            pac = self._pacotes(v)
            descarregados_por_parada = [0] * len(v["paradas"])
            voando_por_parada = [0] * len(v["paradas"])
            for p in pac["carregados"]:
                if p["unload_at"] and p["unload_at"] <= self.now:
                    descarregados_por_parada[p["stop"]] += 1
            for p in pac["voando"]:
                if p["unload_at"] <= self.now:
                    voando_por_parada[p["stop"]] += 1
            origem = v["origem"]
            eventos = [{
                "direction": "load", "site_code": origem["codigo"], "site_name": origem["nome"],
                "count": len(pac["carregados"]),
                "only_loaded": len(pac["carregados"]) - sum(descarregados_por_parada),
                "only_unloaded": None,
            }]
            for j, parada in enumerate(v["paradas"]):
                if v["pernas"][j]["deslacre"] > self.now:
                    continue
                eventos.append({
                    "direction": "unload", "site_code": parada["codigo"], "site_name": parada["nome"],
                    "count": descarregados_por_parada[j] + voando_por_parada[j],
                    "only_loaded": None, "only_unloaded": voando_por_parada[j],
                })
            resultado[sn] = eventos
        return resultado

    def fetch_loaded_parcels(self, shipment_nos, leg_type):
        resultado = {}
        for sn in shipment_nos:
            v = self._viagem(sn)
            if not v or v["tipo"] != leg_type:
                continue
            origem = v["origem"]["codigo"]
            resultado[sn] = [{
                "bill_code": p["bill_code"], "origin_code": origem,
                "next_station_code": v["paradas"][p["stop"]]["codigo"], "scanned_at": p["loaded_at"],
            } for p in self._pacotes(v)["carregados"]]
        return resultado

    def fetch_unloaded_parcels(self, shipment_nos, leg_type):
        resultado = {}
        for sn in shipment_nos:
            v = self._viagem(sn)
            if not v or v["tipo"] != leg_type:
                continue
            pac = self._pacotes(v)
            lista = []
            for p in [*pac["carregados"], *pac["voando"]]:
                if p["unload_at"] and p["unload_at"] <= self.now:
                    parada = v["paradas"][p["stop"]]
                    lista.append({"bill_code": p["bill_code"], "site_code": parada["codigo"],
                                  "site_name": parada["nome"], "scanned_at": p["unload_at"]})
            resultado[sn] = lista
        return resultado

    def fetch_audit_status(self, bill_codes):
        saida = {}
        for bc in bill_codes:
            if _h(bc) % 50 == 0:
                saida[bc] = {
                    "is_abnormal": True, "reason": "Delay registered by operator",
                    "registered_at": self.now - timedelta(hours=1),
                    "registered_site_code": self.rede.scs[_h(bc) % len(self.rede.scs)]["codigo"],
                }
        return saida

    # ============================================================ indicadores
    def fetch_timely_rates(self, day: date):
        if day >= self.now.date():
            return [], []
        rng = _rng(self.seed, "taxas", day)
        fim_semana = day.weekday() >= 5
        linhas = []

        def base(tipo, regional, sc, dc=None):
            return {
                "data": day, "tipo": tipo, "regional_codigo": regional["codigo"], "regional_nome": regional["nome"],
                "sc_codigo": sc["codigo"], "sc_nome": sc["nome"],
                "dc_codigo": dc["codigo"] if dc else "", "dc_nome": dc["nome"] if dc else None,
                "qtd_sem_viagem": None, "qtd_sem_rota": None, "qtd_sem_chegada": None,
                "qtd_destino_errado": None, "bilhetes_op_habil": None, "qtd_sem_shift": None,
                "qtd_anomalia": None, "qtd_falta_cod_2seg": None,
            }

        def fechar(linha, total, taxa):
            no_prazo = int(total * taxa)
            linha.update({"qtd_total": total, "qtd_no_prazo": no_prazo, "qtd_fora_prazo": total - no_prazo,
                          "taxa": round(no_prazo / total, 4) if total else None})
            return linha

        for idx, uf in enumerate(ESTADOS):
            hub = self.rede.hubs[uf]
            piso = [0.78, 0.92, 0.94][idx]
            fator = 0.4 if fim_semana else 1.0
            l = base("sc_hub", hub, hub)
            l["qtd_sem_shift"] = rng.randint(0, 40)
            linhas.append(fechar(l, int(rng.randint(60_000, 110_000) * fator), min(0.99, piso + rng.uniform(-0.05, 0.05))))
            l = base("sc_sc", hub, hub)
            total = int(rng.randint(30_000, 90_000) * fator)
            l.update({"qtd_sem_viagem": rng.randint(0, 300), "qtd_sem_rota": rng.randint(0, 200),
                      "qtd_sem_chegada": rng.randint(0, 500), "qtd_destino_errado": rng.randint(0, 80),
                      "bilhetes_op_habil": rng.randint(0, 100)})
            linhas.append(fechar(l, total, min(0.99, piso + 0.03 + rng.uniform(-0.04, 0.04))))
            for dc in rng.sample([d for d in self.rede.dcs if d["uf"] == uf], 5):
                sc = self.rede.por_codigo[dc["sc"]]
                l = base("hub_pdd", hub, sc, dc)
                l["qtd_anomalia"], l["qtd_falta_cod_2seg"] = rng.randint(0, 30), rng.randint(0, 20)
                linhas.append(fechar(l, int(rng.randint(2_000, 12_000) * fator), min(0.995, piso + 0.04 + rng.uniform(-0.05, 0.05))))
        return linhas, []

    def fetch_open_tickets(self, kind: str):
        janela = config.TICKET_JANELA_DIAS
        tickets = []
        for delta in range(janela + 1):
            d = self.now.date() - timedelta(days=delta)
            rng = _rng(self.seed, "tickets", kind, d)
            for i in range(60 if kind == "comum" else 35):
                criado = datetime(d.year, d.month, d.day) + timedelta(seconds=rng.randint(0, 86_399))
                if criado > self.now:
                    continue
                resolve = criado + timedelta(hours=rng.expovariate(1 / 30))
                if resolve <= self.now:
                    continue
                tipo_ii = rng.choice(["Delay", "Lost", "Damaged", "Wrong address", "Refund"])
                prioritario = kind == "plataforma" and rng.random() < 0.25
                if prioritario:
                    tipo_ii = f"[PRIORITY] {tipo_ii}"
                horas = (config.TICKET_SLA_COMUM_HORAS if kind == "comum" else
                         config.TICKET_SLA_PLATAFORMA_PRIORITY_HORAS if prioritario else config.TICKET_SLA_PLATAFORMA_PADRAO_HORAS)
                dc = rng.choice(self.rede.dcs)
                tid = f"{d:%y%m%d}{i:04d}{1 if kind == 'comum' else 2}"
                tickets.append({
                    "id": tid, "tipo": kind, "work_order_no": f"WO{tid}", "waybill_no": f"BR{_h(tid) % 10**10:010d}",
                    "canal": rng.choice(["email", "chat", "phone", "app"]) if kind == "comum" else "MARKETPLACE",
                    "tipo_i_nome": rng.choice(["Delivery", "Pickup", "Returns"]), "tipo_ii_nome": tipo_ii,
                    "eh_priority": prioritario, "descricao_problema": "Synthetic demo ticket.",
                    "status_codigo": "2", "status_nome": "In progress" if kind == "comum" else rng.choice(["Pending", "In progress"]),
                    "estacao_aceitacao": dc["nome"], "regional_aceitacao": "Regional (demo)",
                    "cliente_nome": rng.choice(["Client A", "Client B", "Client C", "Client D"]) if kind == "comum" else "MARKETPLACE",
                    "responsavel_nome": f"Agent {rng.randint(1, 12):02d}",
                    "is_last_mile": (rng.random() < 0.6) if kind == "plataforma" else None,
                    "data_registro": criado, "horas_sla": horas, "prazo_limite": criado + timedelta(hours=horas),
                    "surplus_process_min": int((criado + timedelta(hours=horas) - self.now).total_seconds() // 60),
                })
        return tickets

    # ================================================================ dropoff
    def _pudo_do_dia(self, d: date) -> list[dict]:
        rng = _rng(self.seed, "pudo", d)
        total = int(2500 * self.scale * (0.55 if d.weekday() >= 5 else 1.0) * rng.uniform(0.85, 1.15))
        estacoes = self._estacoes_pudo()
        origens = [*_ORIGENS_C2C.values(), *_MARKETPLACES]
        pesos_origem = [3] * len(_ORIGENS_C2C) + [12, 5, 4, 3, 2, 2, 1, 1]
        codigos = [f"C{i:04d}" for i in range(1, 61)]
        pesos_cliente = [1 / (i + 1) for i in range(60)]
        status, pesos_status = zip(*_STATUS_PUDO)
        linhas = []
        for idx in range(total):
            hora = rng.choices(range(24), weights=_PESO_HORA)[0]
            enter = datetime(d.year, d.month, d.day, hora, rng.randint(0, 59), rng.randint(0, 59))
            if enter > self.now:
                continue
            est = rng.choice(estacoes)
            linhas.append({
                "order_no": f"P{d:%y%m%d}{idx:06d}", "billcode": f"BR{_h(f'{d}{idx}') % 10**10:010d}",
                "order_source_name": rng.choices(origens, weights=pesos_origem)[0], "mail_name": "Standard",
                "input_time": enter - timedelta(hours=rng.uniform(0.5, 30)), "enter_time": enter,
                "pick_agent_name": est["uf"], "pick_network_name": est["base"], "station_code": est["codigo"],
                "station_name": est["nome"], "province": est["uf"], "city": est["cidade"],
                "order_type_export": rng.choices(status, weights=pesos_status)[0], "order_type": 1,
                "goods_name": "Parcel", "customer_code": rng.choices(codigos, weights=pesos_cliente)[0],
            })
        return linhas

    def _estacoes_pudo(self):
        if not hasattr(self, "_estacoes"):
            rng = _rng(self.seed, "estacoes")
            self._estacoes = []
            for i in range(90):
                dc = self.rede.dcs[i % len(self.rede.dcs)]
                pesos_uf = {"RS": 0.6, "PR": 0.25, "SC": 0.15}
                uf = dc["uf"]
                self._estacoes.append({
                    "codigo": f"PUDO{i + 1:03d}", "nome": f"PUDO {rng.choice(_NOMES)} {i + 1:02d} - {uf}",
                    "uf": uf, "base": dc["nome"], "cidade": f"{rng.choice(_NOMES)} {rng.choice(_SUFIXOS)}",
                    "peso": pesos_uf[uf],
                })
        return self._estacoes

    def fetch_pudo(self, start: datetime, end: datetime):
        linhas, d = [], start.date()
        while d <= end.date():
            linhas += [l for l in self._pudo_do_dia(d) if start <= l["enter_time"] <= end]
            d += timedelta(days=1)
        return linhas

    def fetch_c2c(self, start: datetime, end: datetime):
        municipios = municipios_demo()
        codigos = list(config.C2C_ORDER_SOURCE_CODES)
        linhas, d = [], start.date()
        while d <= end.date():
            rng = _rng(self.seed, "c2c", d)
            total = int(150 * self.scale * (0.5 if d.weekday() >= 5 else 1.0) * rng.uniform(0.8, 1.2))
            for i in range(total):
                entrada = datetime(d.year, d.month, d.day) + timedelta(seconds=rng.randint(0, 86_399))
                if not (start <= entrada <= end and entrada <= self.now):
                    continue
                m = rng.choice(municipios)
                uf_origem = rng.choice(ESTADOS)
                codigo = rng.choice(codigos)
                entregue = rng.random() < 0.55 and entrada + timedelta(days=1) <= self.now
                linhas.append({
                    "id": f"{d:%Y%m%d}{i:05d}", "order_id": f"BR{_h(f'{d}{i}') % 10**10:010d}",
                    "waybill_no": f"BR{_h(f'w{d}{i}') % 10**10:010d}", "numero_encomenda_interna": f"{_h(f'i{d}{i}'):012d}",
                    "order_source_code": codigo, "order_source_name": _ORIGENS_C2C.get(codigo, codigo),
                    "pick_network_name": rng.choice(self.rede.dcs)["nome"], "origin_name": f"{rng.choice(_NOMES)} {rng.choice(_SUFIXOS)}",
                    "origin_province": uf_origem, "dispatch_network_name": rng.choice(self.rede.dcs)["nome"],
                    "destination_name": m["municipio"], "destination_province": m["uf"],
                    "package_number": 1, "goods_type_name": rng.choice(["Documents", "Clothing", "Electronics", "Other"]),
                    "waybill_weight": round(rng.uniform(0.2, 12.0), 2), "input_time": entrada,
                    "collect_time": entrada + timedelta(hours=rng.uniform(1, 20)),
                    "is_sign": 1 if entregue else 0, "is_sign_name": "Signed" if entregue else "Not signed",
                    "sign_time": entrada + timedelta(days=rng.randint(1, 5)) if entregue else None,
                    "latest_scan_type_name": "Delivered" if entregue else "In transit",
                    "latest_scan_network_name": rng.choice(self.rede.dcs)["nome"],
                    "latest_scan_time": min(self.now, entrada + timedelta(hours=rng.uniform(2, 60))),
                })
            d += timedelta(days=1)
        return linhas, False

    def count_pudo_month(self, year: int, month: int, progress: Callable[[int, int], None] | None = None):
        rng = _rng(self.seed, "mensal", year, month)
        dias = monthrange(year, month)[1]
        base_dia = 2500 * self.scale
        sazonal = 1 + 0.25 * ((month % 12) / 11)
        fracao = 1.0
        if (year, month) == (self.now.year, self.now.month):
            fracao = self.now.day / dias
        total = int(base_dia * dias * sazonal * rng.uniform(0.9, 1.1) * fracao)
        paginas = max(1, total // 1000)
        if progress:
            progress(paginas, paginas)
        return {
            "total_pacotes": total, "total_dropoffs": 90 - rng.randint(0, 4), "bases_ativas": 72 - rng.randint(0, 6),
            "paginas_falhas": 0, "total_paginas": paginas, "paginas_percorridas": paginas,
        }
